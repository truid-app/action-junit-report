import * as core from '@actions/core'
import * as glob from '@actions/glob'
import * as fs from 'fs'
import * as parser from 'xml-js'
import * as pathHelper from 'path'
import {applyTransformer} from './utils'

interface InternalTestResult {
  totalCount: number
  skipped: number
  annotations: Annotation[]
}

export interface TestResult {
  checkName: string
  summary: string
  totalCount: number
  skipped: number
  failed: number
  passed: number
  foundFiles: number
  annotations: Annotation[]
}

export interface Annotation {
  path: string
  start_line: number
  end_line: number
  start_column: number
  end_column: number
  annotation_level: 'failure' | 'notice' | 'warning'
  status: 'success' | 'failure' | 'skipped'
  title: string
  message: string
  raw_details: string
}

export interface Position {
  fileName: string
  line: number
}

export interface Transformer {
  searchValue: string
  replaceValue: string
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L6
 *
 * Modification Copyright 2022 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
export async function resolveFileAndLine(
  file: string | null,
  line: string | null,
  className: string,
  output: string
): Promise<Position> {
  let fileName = file ? file : className.split('.').slice(-1)[0]
  const lineNumber = safeParseInt(line)
  try {
    if (fileName && lineNumber) {
      return {fileName, line: lineNumber}
    }

    const escapedFileName = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('::', '/') // Rust test output contains colons between package names - See: https://github.com/mikepenz/action-junit-report/pull/359

    const matches = output.match(new RegExp(` [^ ]*${escapedFileName}.*?:\\d+`, 'g'))
    if (!matches) return {fileName, line: lineNumber || 1}

    const [lastItem] = matches.slice(-1)
    const lineTokens = lastItem.split(':')
    line = lineTokens.pop() || '0'

    // check, if the error message is from a rust file -- this way we have the chance to find
    // out the involved test file
    // See: https://github.com/mikepenz/action-junit-report/pull/360
    {
      const lineNumberPrefix = lineTokens.pop() || ''
      if (lineNumberPrefix.endsWith('.rs')) {
        fileName = lineNumberPrefix.split(' ').pop() || ''
      }
    }

    core.debug(`Resolved file ${fileName} and line ${line}`)

    return {fileName, line: safeParseInt(line) || -1}
  } catch (error) {
    core.warning(`⚠️ Failed to resolve file (${file}) and/or line (${line}) for ${className}`)
    return {fileName, line: safeParseInt(line) || -1}
  }
}

/**
 * Parse the provided string line number, and return its value, or null if it is not available or NaN.
 */
function safeParseInt(line: string | null): number | null {
  if (!line) return null
  const parsed = parseInt(line)
  if (isNaN(parsed)) return null
  return parsed
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L18
 *
 * Modification Copyright 2022 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
export async function resolvePath(fileName: string, excludeSources: string[], followSymlink = false): Promise<string> {
  core.debug(`Resolving path for ${fileName}`)
  const normalizedFilename = fileName.replace(/^\.\//, '') // strip relative prefix (./)
  const globber = await glob.create(`**/${normalizedFilename}.*`, {
    followSymbolicLinks: followSymlink
  })
  const searchPath = globber.getSearchPaths() ? globber.getSearchPaths()[0] : ''
  for await (const result of globber.globGenerator()) {
    core.debug(`Matched file: ${result}`)

    const found = excludeSources.find(v => result.includes(v))
    if (!found) {
      const path = result.slice(searchPath.length + 1)
      core.debug(`Resolved path: ${path}`)
      return path
    }
  }
  return normalizedFilename
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L43
 *
 * Modification Copyright 2022 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
export async function parseFile(
  file: string,
  suiteRegex = '',
  annotatePassed = false,
  checkRetries = false,
  excludeSources: string[] = ['/build/', '/__pycache__/'],
  checkTitleTemplate: string | undefined = undefined,
  testFilesPrefix = '',
  transformer: Transformer[] = [],
  followSymlink = false,
  annotationsLimit = -1,
  truncateStackTraces = true
): Promise<InternalTestResult> {
  core.debug(`Parsing file ${file}`)

  const data: string = fs.readFileSync(file, 'utf8')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let report: any
  try {
    report = JSON.parse(parser.xml2json(data, {compact: true}))
  } catch (error) {
    core.error(`⚠️ Failed to parse file (${file}) with error ${error}`)
    return {
      totalCount: 0,
      skipped: 0,
      annotations: []
    }
  }

  return parseSuite(
    report,
    '',
    suiteRegex,
    annotatePassed,
    checkRetries,
    excludeSources,
    checkTitleTemplate,
    testFilesPrefix,
    transformer,
    followSymlink,
    annotationsLimit,
    truncateStackTraces
  )
}

function templateVar(varName: string): string {
  return `{{${varName}}}`
}

async function parseSuite(
  /* eslint-disable  @typescript-eslint/no-explicit-any */
  suite: any,
  parentName: string,
  suiteRegex: string,
  annotatePassed = false,
  checkRetries = false,
  excludeSources: string[],
  checkTitleTemplate: string | undefined = undefined,
  testFilesPrefix = '',
  transformer: Transformer[],
  followSymlink: boolean,
  annotationsLimit: number,
  truncateStackTraces: boolean
): Promise<InternalTestResult> {
  let totalCount = 0
  let skipped = 0
  const annotations: Annotation[] = []

  if (!suite.testsuite && !suite.testsuites) {
    return {totalCount, skipped, annotations}
  }

  const testsuites = suite.testsuite
    ? Array.isArray(suite.testsuite)
      ? suite.testsuite
      : [suite.testsuite]
    : Array.isArray(suite.testsuites.testsuite)
      ? suite.testsuites.testsuite
      : [suite.testsuites.testsuite]

  for (const testsuite of testsuites) {
    if (!testsuite) {
      return {totalCount, skipped, annotations}
    }

    let suiteName = ''
    if (suiteRegex) {
      if (parentName) {
        suiteName = `${parentName}/${testsuite._attributes.name}`
      } else if (suiteRegex !== '*') {
        suiteName = testsuite._attributes.name.match(suiteRegex)
      }
      if (!suiteName) {
        suiteName = testsuite._attributes.name
      }
    }

    const res = await parseSuite(
      testsuite,
      suiteName,
      suiteRegex,
      annotatePassed,
      checkRetries,
      excludeSources,
      checkTitleTemplate,
      testFilesPrefix,
      transformer,
      followSymlink,
      annotationsLimit,
      truncateStackTraces
    )
    totalCount += res.totalCount
    skipped += res.skipped
    annotations.push(...res.annotations)

    if (!testsuite.testcase) {
      continue
    } else if (annotationsLimit > 0) {
      const count = annotations.filter(a => a.annotation_level === 'failure' || annotatePassed).length
      if (count >= annotationsLimit) {
        return {totalCount, skipped, annotations}
      }
    }

    let testcases = Array.isArray(testsuite.testcase)
      ? testsuite.testcase
      : testsuite.testcase
        ? [testsuite.testcase]
        : []

    if (checkRetries) {
      // identify duplicates, in case of flaky tests, and remove them
      const testcaseMap = new Map<string, any>()
      for (const testcase of testcases) {
        const key = testcase._attributes.name
        if (testcaseMap.get(key) !== undefined) {
          // testcase with matching name exists
          const failed = testcase.failure || testcase.error
          const previousFailed = testcaseMap.get(key).failure || testcaseMap.get(key).error
          if (failed && !previousFailed) {
            // previous is a success, drop failure
            core.debug(`Drop flaky test failure for (1): ${key}`)
          } else if (!failed && previousFailed) {
            // previous failed, new one not, replace
            testcaseMap.set(key, testcase)
            core.debug(`Drop flaky test failure for (2): ${key}`)
          }
        } else {
          testcaseMap.set(key, testcase)
        }
      }
      testcases = Array.from(testcaseMap.values())
    }

    for (const testcase of testcases) {
      totalCount++

      const testFailure = testcase.failure || testcase.error // test failed
      const skip =
        testcase.skipped || testcase._attributes.status === 'disabled' || testcase._attributes.status === 'ignored'
      const failed = testFailure && !skip // test faiure, but was skipped -> don't fail if a ignored test failed
      const success = !testFailure // not a failure -> thus a success

      // in some definitions `failure` may be an array
      const failures = testcase.failure
        ? Array.isArray(testcase.failure)
          ? testcase.failure
          : [testcase.failure]
        : undefined
      // the action only supports 1 failure per testcase
      const failure = failures ? failures[0] : undefined

      // in some definitions `failure` may be an array
      const systemOuts = testcase['system-out']
        ? Array.isArray(testcase['system-out'])
          ? testcase['system-out']
          : [testcase['system-out']]
        : undefined
      // the action only supports 1 failure per testcase
      const systemOut = systemOuts ? systemOuts[0] : undefined

      if (skip) {
        skipped++
      }
      const stackTrace: string = (
        (failure && failure._cdata) ||
        (failure && failure._text) ||
        (testcase.error && testcase.error._cdata) ||
        (testcase.error && testcase.error._text) ||
        ''
      )
        .toString()
        .trim()

      const stackTraceMessage = truncateStackTraces ? stackTrace.split('\n').slice(0, 2).join('\n') : stackTrace
      const sysout: string | undefined = ((systemOut && systemOut._cdata) || (systemOut && systemOut._text))
        ?.toString()
        ?.trim()

      const message: string = (
        (failure && failure._attributes && failure._attributes.message) ||
        (testcase.error && testcase.error._attributes && testcase.error._attributes.message) ||
        stackTraceMessage ||
        testcase._attributes.name
      ).trim()

      const pos = await resolveFileAndLine(
        testcase._attributes.file ||
          failure?._attributes?.file ||
          (testsuite._attributes !== undefined ? testsuite._attributes.file : null),
        testcase._attributes.line ||
          failure?._attributes?.line ||
          (testsuite._attributes !== undefined ? testsuite._attributes.line : null),
        testcase._attributes.classname ? testcase._attributes.classname : testcase._attributes.name,
        stackTrace
      )

      let transformedFileName = pos.fileName
      for (const r of transformer) {
        transformedFileName = applyTransformer(r, transformedFileName)
      }

      let resolvedPath =
        failed || (annotatePassed && success)
          ? await resolvePath(transformedFileName, excludeSources, followSymlink)
          : transformedFileName

      core.debug(`Path prior to stripping: ${resolvedPath}`)

      const githubWorkspacePath = process.env['GITHUB_WORKSPACE']
      if (githubWorkspacePath) {
        resolvedPath = resolvedPath.replace(`${githubWorkspacePath}/`, '') // strip workspace prefix, make the path relative
      }

      let title = ''
      if (checkTitleTemplate) {
        // ensure to not duplicate the test_name if file_name is equal

        const fileName = pos.fileName !== testcase._attributes.name ? pos.fileName : ''
        const baseClassName = testcase._attributes.classname
          ? testcase._attributes.classname
          : testcase._attributes.name
        const className = baseClassName.split('.').slice(-1)[0]
        title = checkTitleTemplate
          .replace(templateVar('FILE_NAME'), fileName)
          .replace(templateVar('SUITE_NAME'), suiteName ?? '')
          .replace(templateVar('TEST_NAME'), testcase._attributes.name)
          .replace(templateVar('CLASS_NAME'), className)
      } else if (pos.fileName !== testcase._attributes.name) {
        title = suiteName
          ? `${pos.fileName}.${suiteName}/${testcase._attributes.name}`
          : `${pos.fileName}.${testcase._attributes.name}`
      } else {
        title = suiteName ? `${suiteName}/${testcase._attributes.name}` : `${testcase._attributes.name}`
      }

      // optionally attach the prefix to the path
      resolvedPath = testFilesPrefix ? pathHelper.join(testFilesPrefix, resolvedPath) : resolvedPath

      // fish the time-taken out of the test case attributes, if present
      const testTime = testcase._attributes.time === undefined ? '' : ` (${testcase._attributes.time}s)`

      core.info(`${resolvedPath}:${pos.line} | ${message.split('\n', 1)[0]}${testTime}`)

      let rawDetails = stackTrace
      if (sysout) {
        rawDetails += `\n\n${sysout}`
      }

      annotations.push({
        path: resolvedPath,
        start_line: pos.line,
        end_line: pos.line,
        start_column: 0,
        end_column: 0,
        annotation_level: success || skip ? 'notice' : 'failure', // a skipped test shall not fail the run
        status: skip ? 'skipped' : success ? 'success' : 'failure',
        title: escapeEmoji(title),
        message: escapeEmoji(message),
        raw_details: escapeEmoji(rawDetails)
      })

      if (annotationsLimit > 0) {
        const count = annotations.filter(a => a.annotation_level === 'failure' || annotatePassed).length
        if (count >= annotationsLimit) {
          return {totalCount, skipped, annotations}
        }
      }
    }
  }
  return {totalCount, skipped, annotations}
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L113
 *
 * Modification Copyright 2022 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
export async function parseTestReports(
  checkName: string,
  summary: string,
  reportPaths: string,
  suiteRegex: string,
  annotatePassed = false,
  checkRetries = false,
  excludeSources: string[],
  checkTitleTemplate: string | undefined = undefined,
  testFilesPrefix = '',
  transformer: Transformer[] = [],
  followSymlink = false,
  annotationsLimit = -1,
  truncateStackTraces = true
): Promise<TestResult> {
  core.debug(`Process test report for: ${reportPaths} (${checkName})`)
  const globber = await glob.create(reportPaths, {followSymbolicLinks: followSymlink})
  let annotations: Annotation[] = []
  let totalCount = 0
  let skipped = 0
  let foundFiles = 0
  for await (const file of globber.globGenerator()) {
    foundFiles++
    core.debug(`Parsing report file: ${file}`)

    const {
      totalCount: c,
      skipped: s,
      annotations: a
    } = await parseFile(
      file,
      suiteRegex,
      annotatePassed,
      checkRetries,
      excludeSources,
      checkTitleTemplate,
      testFilesPrefix,
      transformer,
      followSymlink,
      annotationsLimit,
      truncateStackTraces
    )
    if (c === 0) continue
    totalCount += c
    skipped += s
    annotations = annotations.concat(a)

    if (annotationsLimit > 0) {
      const count = annotations.filter(an => an.annotation_level === 'failure' || annotatePassed).length
      if (count >= annotationsLimit) {
        break
      }
    }
  }

  // get the count of passed and failed tests.
  const failed = annotations.filter(a => a.annotation_level === 'failure').length
  const passed = totalCount - failed - skipped

  return {
    checkName,
    summary,
    totalCount,
    skipped,
    failed,
    passed,
    foundFiles,
    annotations
  }
}

/**
 * Escape emoji sequences.
 */
export function escapeEmoji(input: string): string {
  const regex =
    /[\u{1f300}-\u{1f5ff}\u{1f900}-\u{1f9ff}\u{1f600}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{2600}-\u{26ff}\u{2700}-\u{27bf}\u{1f1e6}-\u{1f1ff}\u{1f191}-\u{1f251}\u{1f004}\u{1f0cf}\u{1f170}-\u{1f171}\u{1f17e}-\u{1f17f}\u{1f18e}\u{3030}\u{2b50}\u{2b55}\u{2934}-\u{2935}\u{2b05}-\u{2b07}\u{2b1b}-\u{2b1c}\u{3297}\u{3299}\u{303d}\u{00a9}\u{00ae}\u{2122}\u{23f3}\u{24c2}\u{23e9}-\u{23ef}\u{25b6}\u{23f8}-\u{23fa}]/gu
  return input.replace(regex, ``) // replace emoji with empty string (\\u${(match.codePointAt(0) || "").toString(16)})
}
