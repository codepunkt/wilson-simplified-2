import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'

import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import grayMatter from 'gray-matter'
import MarkdownIt from 'markdown-it'
import { transform } from 'sucrase'
import debug from 'debug'
import { walk } from 'estree-walker'
import { stringify as stringifyQuery } from 'qs'
import { parse as parseJavaScript } from 'acorn'
import { generate } from 'astring'
import slugify from 'slugify'
import chalk from 'chalk'
import fg from 'fast-glob'

const PAGE_EXTENSIONS = ['.jsx', '.md']
const PAGINATION_PAGE_SIZE = 3
const MODULE_ID_VIRTUAL = 'virtual:routes'

const md = new MarkdownIt()
const frontmatterCache = new Map()
const PAGE_DIRECTORY = path.join(process.cwd(), 'src', 'pages')
const layoutPath = path.join(process.cwd(), 'src', 'layouts', 'page.jsx')

const transformJsx = (code) => {
  return transform(code, {
    transforms: ['jsx'],
    production: true,
    jsxPragma: 'h',
    jsxFragmentPragma: 'Fragment',
  }).code
}

const toSlug = (string) => {
  return slugify(string, { lower: true, locale: 'en' })
}

const isPage = (filename) => {
  const extension = path.extname(filename)
  return (
    filename.startsWith(PAGE_DIRECTORY) && PAGE_EXTENSIONS.includes(extension)
  )
}

const isMarkdownPage = (filename) => {
  return isPage(filename) && path.extname(filename) === '.md'
}

const isJavascriptPage = (filename) => {
  return isPage(filename) && path.extname(filename) === '.jsx'
}

const isContentPage = (type) => {
  return type === 'content' || type === undefined
}

const splitId = (id) => {
  const [filename, rawQuery] = id.split('?', 2)
  return { filename, rawQuery }
}

const hasIntersection = (arr1, arr2) => {
  return arr1.filter((v) => arr2.includes(v)).length > 0
}

const getContentPages = (sources, taxonomyName, terms) => {
  return Array.from(sources.entries())
    .map(([absolutePath, { frontmatter }]) =>
      isContentPage(frontmatter.type) &&
      hasIntersection((frontmatter.taxonomies ?? {})[taxonomyName] ?? [], terms)
        ? { route: pagePathToRoute(absolutePath), frontmatter }
        : null
    )
    .filter(Boolean)
}

const replaceTerm = (string, term) => string.replace(/\[term\]/, term)

/**
 * transforms source frontmatter to page frontmatter
 */
const transformFrontmatter = (frontmatter, term) => {
  const frontmatterCopy = { ...frontmatter }
  delete frontmatterCopy.permalink

  return {
    ...frontmatterCopy,
    title: term ? replaceTerm(frontmatter.title, term) : frontmatter.title,
  }
}

const chunkArray = (array, size) => {
  let result = []
  for (let i = 0; i < array.length; i += size) {
    let chunk = array.slice(i, i + size)
    result.push(chunk)
  }
  return result
}

const pagePathToRoute = (pagePath) => {
  const relativePath = path.relative(PAGE_DIRECTORY, pagePath)
  const extensionRegexp = new RegExp(`(${PAGE_EXTENSIONS.join('|')})$`)
  const withoutExtension = relativePath.replace(extensionRegexp, '')
  const withoutIndex = withoutExtension.replace(/\/?index$/, '')
  return `/${withoutIndex}/`.replace(/\/\//g, '/')
}

const createPaginatedRoute = (route, pageNumber) => {
  return `${route}${pageNumber === 1 ? '' : `page-${pageNumber}/`}`
}

const createPagination = (baseRoute, currentPage, numPages) => {
  return {
    currentPage,
    previousPage:
      currentPage === 1
        ? undefined
        : createPaginatedRoute(baseRoute, currentPage - 1),
    nextPage:
      numPages === 0 ||
      currentPage === Math.ceil(numPages / PAGINATION_PAGE_SIZE)
        ? undefined
        : createPaginatedRoute(baseRoute, currentPage + 1),
  }
}

// =====================================================
// FRONTMATTER
// =====================================================

/**
 * Parses markdown frontmatter
 *
 * @param {string} markdownString - Markdown string
 */
const parseMarkdownFrontmatter = (markdownString) => {
  return grayMatter(markdownString).data
}

/**
 * Parses javascript frontmatter
 *
 * @param {string} javascriptString - JavaScript string
 */
const parseJavascriptFrontmatter = (javascriptString) => {
  const js = transformJsx(javascriptString)
  const ast = parseJavaScript(js, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  })
  let frontmatterNode = null
  walk(ast, {
    enter(node) {
      if (node.type !== 'ExportNamedDeclaration') return
      if (
        node.declaration.type !== 'VariableDeclaration' ||
        node.declaration.kind !== 'const'
      )
        return
      if (node.declaration.declarations.length !== 1) return
      const declarator = node.declaration.declarations[0]
      if (declarator.type !== 'VariableDeclarator') return
      if (
        declarator.id.type !== 'Identifier' ||
        declarator.id.name !== 'frontmatter'
      )
        return
      if (declarator.init.type !== 'ObjectExpression') return
      frontmatterNode = declarator.init
    },
  })
  const objSource = frontmatterNode
    ? generate(frontmatterNode, { indent: '', lineEnd: '' })
    : '{}'
  const data = {
    // eslint-disable-next-line
    ...(0, eval)(`const obj=()=>(${objSource});obj`)(),
  }
  return data
}

/**
 * Returns frontmatter for page
 *
 * @param {string} absolutePath - Absolute path to page.
 */
const getFrontmatter = (absolutePath, content, contentHash) => {
  if (!isPage(absolutePath)) {
    throw new Error(`${absolutePath} is not a page`)
  }

  if (frontmatterCache.has(contentHash)) {
    return frontmatterCache.get(contentHash)
  }

  let frontmatter
  if (path.extname(absolutePath) === '.md') {
    frontmatter = parseMarkdownFrontmatter(content)
  } else {
    frontmatter = parseJavascriptFrontmatter(content)
  }

  debug('w:frontmatter')(
    '%s frontmatter %o',
    path.relative(process.cwd(), absolutePath),
    frontmatter
  )
  frontmatterCache.set(contentHash, frontmatter)
  return frontmatter
}

// =====================================================
// UTIL
// =====================================================

/**
 * Creates a duplicate-free version of an array
 *
 * @param {array} array - The array to inspect
 */
const unique = (array) => {
  return [...new Set(array)]
}

// =====================================================
// OPTIONS
// =====================================================

/**
 * Returns wilson options.
 *
 * @param {string} root - Root directory path
 */
const getOptions = (root = process.cwd()) => {
  const configName = 'wilson.config.js'
  const configPath = path.resolve(root, configName)
  const hasConfig = fs.existsSync(configPath)
  const require = createRequire(import.meta.url)
  const defaults = {}
  const config = hasConfig ? require(configPath) : {}
  const options = { ...defaults, ...config, root }
  debug('w:options')(options)
  return options
}

// =====================================================
// SOURCES
// =====================================================

/**
 * Reads a file from disk and returns contents and content hash
 *
 * @param {string} absolutePath - Absolute path to file
 */
const readFile = (absolutePath) => {
  const content = fs.readFileSync(absolutePath, 'utf8')
  const contentHash = crypto.createHash('md5').update(content).digest('hex')
  return { content, contentHash }
}

/**
 * Returns information about page sources
 *
 * @param {object} options - Wilson options.
 */
const resolveSources = (options) => {
  const sources = new Map()
  const pagePath = path.resolve(options.root, PAGE_DIRECTORY)
  const ext = `{${PAGE_EXTENSIONS.join(',')}}`
  const files = fg.sync(`**/*${ext}`, {
    onlyFiles: true,
    cwd: pagePath,
  })

  files.forEach((file) => addSource(sources, options, file))

  return sources
}

const addSource = (sources, options, pagePath) => {
  const relativePath = path.relative(
    options.root,
    path.join(PAGE_DIRECTORY, pagePath)
  )
  const absolutePath = path.resolve(options.root, relativePath)
  const extension = path.extname(pagePath)
  const { content, contentHash } = readFile(absolutePath)
  const frontmatter = getFrontmatter(absolutePath, content, contentHash)

  const source = {
    extension,
    absolutePath,
    relativePath,
    pagePath,
    frontmatter,
  }

  debug('w:add-source')(source)
  sources.set(absolutePath, source)
  return source
}

const updateSource = (sources, sourcePath, frontmatter, options) => {
  let source = sources.get(sourcePath)

  if (source) {
    sources.delete(sourcePath)
    source.frontmatter = frontmatter
  } else {
    source = addSource(
      sources,
      options,
      path.relative(PAGE_DIRECTORY, sourcePath)
    )
  }

  sources.set(sourcePath, source)
  return source
}

const getTaxonomyDependencies = (sources, taxonomies) => {
  return Array.from(sources.values())
    .map(({ absolutePath, frontmatter }) => {
      const { taxonomyName, type, selectedTerms } = frontmatter
      const isTaxonomyTarget =
        type === 'taxonomy' && Array.isArray(taxonomies[taxonomyName])
      const isSelectTarget =
        type === 'select' &&
        hasIntersection(taxonomies[taxonomyName] ?? [], selectedTerms)
      return isTaxonomyTarget || isSelectTarget ? absolutePath : false
    })
    .filter(Boolean)
}

const getTaxonomyTerms = (sources, taxonomyName) => {
  const sourceArray = Array.from(sources.values())
  const terms = unique(
    sourceArray
      .map((source) => {
        const taxonomies = source.frontmatter.taxonomies ?? {}
        return taxonomies[taxonomyName] ?? []
      })
      .flat()
  )
  return terms
}

// =====================================================
// PAGES
// =====================================================

const getPage = (pages, sourcePath, queryString) => {
  return pages.get(queryString ? `${sourcePath}?${queryString}` : sourcePath)
}

const getPageProps = (pages, sourcePath, queryString) => {
  return getPage(pages, sourcePath, queryString).props
}

const updateSourcePages = (pages, sources, source) => {
  debug('w:hmr')(`updating ${chalk.green('%s')}`, source.relativePath)
  deleteSourcePages(pages, source)
  addSourcePages(pages, sources, source)
}

const deleteSourcePages = (pages, source) => {
  Array.from(pages.entries()).forEach(([key, page]) => {
    if (page.sourcePath === source.absolutePath) {
      pages.delete(key)
    }
  })
}

const addSelectSourcePages = (sources, source, pages) => {
  const {
    absolutePath,
    frontmatter: { selectedTerms, taxonomyName },
  } = source

  const taxonomyPages = getContentPages(sources, taxonomyName, selectedTerms)
  const chunkedPages = chunkArray(taxonomyPages, PAGINATION_PAGE_SIZE)
  if (chunkedPages.length === 0) chunkedPages.push([])

  chunkedPages.forEach((contentPages, i) => {
    const pageNo = i + 1
    const query = { page: pageNo }
    const queryString = stringifyQuery(query)
    const baseRoute = pagePathToRoute(absolutePath)
    const route = createPaginatedRoute(baseRoute, pageNo)
    const frontmatter = transformFrontmatter(source.frontmatter)
    const pagination = createPagination(baseRoute, pageNo, taxonomyPages.length)
    const page = {
      route,
      sourcePath: absolutePath,
      query,
      queryString,
      props: { frontmatter, pages: contentPages, pagination },
    }
    debug('w:add-page')(page)
    pages.set(`${absolutePath}?${queryString}`, page)
  })
}

const addTaxonomySourcePages = (sources, source, pages) => {
  const {
    absolutePath,
    frontmatter: { taxonomyName },
  } = source

  getTaxonomyTerms(sources, taxonomyName).forEach((term) => {
    const taxonomyPages = getContentPages(sources, taxonomyName, [term])
    const chunkedPages = chunkArray(taxonomyPages, PAGINATION_PAGE_SIZE)
    if (chunkedPages.length === 0) chunkedPages.push([])

    chunkedPages.forEach((contentPages, i) => {
      const pageNo = i + 1
      const query = { selectedTerm: term, page: pageNo }
      const queryString = stringifyQuery(query)
      const baseRoute = replaceTerm(source.frontmatter.permalink, toSlug(term))
      const route = createPaginatedRoute(baseRoute, pageNo)
      const frontmatter = transformFrontmatter(source.frontmatter, term)
      const pagination = createPagination(
        baseRoute,
        pageNo,
        taxonomyPages.length
      )
      const page = {
        route,
        sourcePath: absolutePath,
        query,
        queryString,
        props: { frontmatter, pages: contentPages, term, pagination },
      }
      debug('w:add-page')(page)
      pages.set(`${absolutePath}?${queryString}`, page)
    })
  })
}

/**
 * Adds all pages generated from a page source to the map of pages.
 *
 * @param {Map<string, Page>} pages - Map of pages.
 * @param {Map<string, Source>} sources - Map of sources.
 * @param {Source} source - Page source.
 */
const addSourcePages = (pages, sources, source) => {
  if (source.frontmatter.type === 'taxonomy') {
    addTaxonomySourcePages(sources, source, pages)
  } else if (source.frontmatter.type === 'select') {
    addSelectSourcePages(sources, source, pages)
  } else {
    const route = pagePathToRoute(source.absolutePath)
    const frontmatter = transformFrontmatter(source.frontmatter)
    const props = { frontmatter }
    if (source.frontmatter.type === 'terms') {
      props.terms = getTaxonomyTerms(
        sources,
        source.frontmatter.taxonomyName
      ).map((term) => ({
        term,
        slug: toSlug(term),
      }))
    }
    const page = { route, sourcePath: source.absolutePath, props }
    debug('w:add-page')(page)
    pages.set(source.absolutePath, page)
  }
}

/**
 * Returns a map that maps module ids to page objects.
 *
 * @param {Map<string, Source>} pageSources - Map of page source objects
 */
const resolvePages = (pageSources) => {
  const pages = new Map()

  pageSources.forEach((pageSource) => {
    addSourcePages(pages, pageSources, pageSource)
  })

  return pages
}

/**
 * Creates code for a javascript page.
 *
 * @param {string} sourcePath - Absolute path to source file
 * @param {string} sourceCode - Source file content
 * @param {string} rawQuery - Module query string
 * @param {string} layoutPath - Absolute path to layout file
 * @param {Map<string, Page>} pages - Map of pages
 */
const createCodeForJavascriptPage = (
  sourcePath,
  sourceCode,
  rawQuery,
  layoutPath,
  pages
) => {
  const props = getPageProps(pages, sourcePath, rawQuery)
  const jsx = `
    ${sourceCode}
    import Layout from '${layoutPath}';
    const props=${JSON.stringify(props)};
    const Wrapper = () => <Layout {...props}><Page {...props} /></Layout>;
    export default Wrapper;
  `
  return transformJsx(jsx)
}

/**
 * Creates code for a markdown page.
 *
 * @param {string} sourcePath - Absolute path to source file
 * @param {string} sourceCode - Source file content
 * @param {string} layoutPath - Absolute path to layout file
 * @param {Map<string, Source>} sources - Map of sources
 */
const createCodeForMarkdownPage = (
  sourcePath,
  sourceCode,
  layoutPath,
  sources
) => {
  const { content } = grayMatter(sourceCode)
  const html = md.render(content.replace(/^\n/, '').replace(/\n$/, ''))
  const props = { frontmatter: sources.get(sourcePath).frontmatter }
  const jsx = `
      import {h,Fragment} from "preact";
      import Layout from '${layoutPath}';
      const props=${JSON.stringify(props)};
      const Wrapper = () => <Layout {...props}>${html}</Layout>;
      export default Wrapper;
    `
  return transformJsx(jsx)
}

// =====================================================
// HMR
// =====================================================

/**
 * Handles added files,
 */
const handleFileAdd = async (file, moduleGraph, watcher) => {
  if (!isPage(file)) {
    return
  }

  await moduleGraph.ensureEntryFromUrl(file)
  watcher.emit('change', file)
  // ws.send({ type: 'full-reload' })
}

/**
 * Handles updates of existing files
 *
 * @param {string} file - The path of the updated file
 * @param {ModuleNode[]} modules - The array of affected module nodes
 * @param {ModuleGraph} moduleGraph - The module graph
 */
const handleFileUpdate = (
  file,
  modules,
  moduleGraph,
  sources,
  pages,
  options
) => {
  const { filename } = splitId(file)

  if (!isPage(filename)) {
    return
  }

  const moduleNodes = [...modules]
  const { content, contentHash } = readFile(filename)
  const frontmatter = getFrontmatter(filename, content, contentHash)

  if (isContentPage()) {
    const source = sources.get(filename)
    const relatedTaxonomies = source
      ? mergeTaxonomyValues(
          frontmatter.taxonomies,
          source.frontmatter.taxonomies ?? {}
        )
      : frontmatter.taxonomies
    const dependencies = getTaxonomyDependencies(sources, relatedTaxonomies)
    dependencies.forEach((dependency) => {
      moduleNodes.push(
        ...Array.from(moduleGraph.fileToModulesMap.get(dependency) ?? [])
      )
    })
  }

  const sourcesToUpdate = unique(moduleNodes.map(({ file }) => file))
  sourcesToUpdate.forEach((sourcePath) => {
    const { content, contentHash } = readFile(sourcePath)
    const frontmatter = getFrontmatter(sourcePath, content, contentHash)
    const updatedSource = updateSource(
      sources,
      sourcePath,
      frontmatter,
      options
    )
    updateSourcePages(pages, sources, updatedSource)
  })

  return moduleNodes
}

/**
 * Merges taxonomy values
 *
 * @param {Array} taxonomies1 - First taxonomies
 * @param {Array} taxonomies2 - Second taxonomies
 */
const mergeTaxonomyValues = (taxonomies1, taxonomies2) => {
  const result = {}
  Object.keys(taxonomies1).map((key) => {
    result[key] = taxonomies1[key]
  })
  Object.keys(taxonomies2).map((key) => {
    result[key] = unique([...(result[key] ?? []), ...taxonomies2[key]])
  })
  return result
}

// =====================================================
// VIRTUAL
// =====================================================

/**
 * Creates virtual module source code.
 *
 * @param {Map<string, Page>} pages - Page data
 */
const createVirtualModule = (pages) => {
  const pageValues = Array.from(pages.values())
  const code = `
    import { h } from 'preact';
    import { lazy } from 'preact-iso';
    ${pageValues
      .map(({ sourcePath, query }, i) => {
        return `const Page_${i} = lazy(() => import('${sourcePath}${
          query ? `?${stringifyQuery(query)}` : ''
        }'));`
      })
      .join('')}
    export default [${pageValues
      .map(({ route }, i) => {
        return `h(Page_${i},{path:'${route}'})`
      })
      .join(',')}];
  `
  return code
}

// =====================================================
// PLUGIN
// =====================================================

const wilsonPlugin = () => {
  let options, sources, pages

  return {
    name: 'vite-plugin-wilson',
    enforce: 'pre',
    configResolved({ root }) {
      options = getOptions(root)
      sources = resolveSources(options)
      pages = resolvePages(sources)
    },
    async handleHotUpdate({ file, modules, server: { moduleGraph } }) {
      return handleFileUpdate(
        file,
        modules,
        moduleGraph,
        sources,
        pages,
        options
      )
    },
    configureServer({ moduleGraph, watcher }) {
      watcher.on('add', async (file) => {
        await handleFileAdd(file, moduleGraph, watcher)
      })
    },
    resolveId(id) {
      if (id === MODULE_ID_VIRTUAL) {
        return id
      }
    },
    async load(id) {
      if (id === MODULE_ID_VIRTUAL) {
        return createVirtualModule(pages)
      }
    },
    transform(code, id) {
      const { filename, rawQuery } = splitId(id)
      if (isPage(filename)) {
        return isMarkdownPage(filename)
          ? createCodeForMarkdownPage(filename, code, layoutPath, sources)
          : createCodeForJavascriptPage(
              filename,
              code,
              rawQuery,
              layoutPath,
              pages
            )
      }
    },
  }
}

// =====================================================
// VITE
// =====================================================

export default defineConfig({
  clearScreen: false,
  esbuild: {
    jsxInject: `import { h, Fragment } from 'preact'`,
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
  },
  logLevel: 'silent',
  plugins: [wilsonPlugin(), preact],
})

// HMR
// =====================================================
// [x] pagination page size change
// [x] frontmatter change
// [x] frontmatter change reflected on select page
// [x] frontmatter change reflected on taxonomy page
// [ ] deleting a page
// [x] adding a page
