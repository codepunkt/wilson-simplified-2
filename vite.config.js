import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import grayMatter from 'gray-matter'
import MarkdownIt from 'markdown-it'
import { transform } from 'sucrase'
import Debug from 'debug'
import { walk } from 'estree-walker'
import { stringify as stringifyQuery } from 'qs'
import { parse as parseJavaScript } from 'acorn'
import { generate } from 'astring'
import slugify from 'slugify'
import fg from 'fast-glob'

const PAGE_EXTENSIONS = ['.jsx', '.md']
const PAGINATION_PAGE_SIZE = 2
const MODULE_ID_VIRTUAL = 'virtual:routes'

const md = new MarkdownIt()
const hotUpdateCache = new Map()
const contentPagesCache = new Map()
const pageDirectory = path.join(process.cwd(), 'src', 'pages')
const layoutPath = path.join(process.cwd(), 'src', 'layouts', 'page.jsx')

const debug = {
  hmr: Debug('wilson:hmr'),
  options: Debug('wilson:options'),
  pages: Debug('wilson:pages'),
  sources: Debug('wilson:sources'),
}

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
    filename.startsWith(pageDirectory) && PAGE_EXTENSIONS.includes(extension)
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
  const cacheKey = `${taxonomyName}:${terms.join(';')}`
  if (!contentPagesCache.has(cacheKey)) {
    contentPagesCache.set(
      cacheKey,
      Array.from(sources.entries())
        .map(([absolutePath, { frontmatter }]) =>
          isContentPage(frontmatter.type) &&
          hasIntersection(
            (frontmatter.taxonomies ?? {})[taxonomyName] ?? [],
            terms
          )
            ? { route: pagePathToRoute(absolutePath), frontmatter }
            : null
        )
        .filter(Boolean)
    )
  }
  return contentPagesCache.get(cacheKey)
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
  const relativePath = path.relative(pageDirectory, pagePath)
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

const parseFrontmatter = (code, extension) => {
  if (extension === '.md') {
    return grayMatter(code).data
  } else if (extension === '.jsx') {
    const js = transformJsx(code)
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
}

const resolveOptions = (root) => {
  const configName = 'wilson.config.js'
  const configPath = path.resolve(root, configName)
  const hasConfig = fs.existsSync(configPath)
  const require = createRequire(import.meta.url)
  const defaults = {}
  const config = hasConfig ? require(configPath) : {}
  return { ...defaults, ...config, root }
}

// =====================================================
// SOURCES
// =====================================================

const resolveSources = (options) => {
  const sourcesDir = 'src/pages'
  const sources = new Map()
  const pagePath = path.resolve(options.root, sourcesDir)
  const ext = `{${PAGE_EXTENSIONS.join(',')}}`
  const files = fg.sync(`**/*${ext}`, {
    onlyFiles: true,
    cwd: pagePath,
  })

  files.forEach((pagePath) => {
    const relativePath = path.join(sourcesDir, pagePath)
    const absolutePath = path.resolve(options.root, relativePath)
    const extension = path.extname(pagePath)
    const sourceCode = fs.readFileSync(absolutePath, 'utf-8')
    const frontmatter = parseFrontmatter(sourceCode, extension)

    sources.set(absolutePath, {
      extension,
      absolutePath,
      relativePath,
      pagePath,
      // sourceCode,
      frontmatter,
    })
  })

  return sources
}

const getTaxonomyTerms = (sources, taxonomyName) => {
  const sourceArray = Array.from(sources.values())
  const termSet = new Set(
    sourceArray
      .map((source) => {
        const taxonomies = source.frontmatter.taxonomies ?? {}
        return taxonomies[taxonomyName] ?? []
      })
      .flat()
  )
  return [...termSet]
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

const updateSource = (sources, sourcePath, frontmatter) => {
  const source = sources.get(sourcePath)
  sources.delete(sourcePath)
  source.frontmatter = frontmatter
  sources.set(sourcePath, source)
  return source
}

const updateSourcePages = (pages, sources, source) => {
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
    const page = i + 1
    const query = { page }
    const queryString = stringifyQuery(query)
    const baseRoute = pagePathToRoute(absolutePath)
    const route = createPaginatedRoute(baseRoute, page)
    const frontmatter = transformFrontmatter(source.frontmatter)
    const pagination = createPagination(baseRoute, page, taxonomyPages.length)
    pages.set(`${absolutePath}?${queryString}`, {
      route,
      sourcePath: absolutePath,
      query,
      queryString,
      props: { frontmatter, pages: contentPages, pagination },
    })
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
      const page = i + 1
      const query = { selectedTerm: term, page }
      const queryString = stringifyQuery(query)
      const baseRoute = replaceTerm(source.frontmatter.permalink, toSlug(term))
      const route = createPaginatedRoute(baseRoute, page)
      const frontmatter = transformFrontmatter(source.frontmatter, term)
      const pagination = createPagination(baseRoute, page, taxonomyPages.length)
      pages.set(`${absolutePath}?${queryString}`, {
        route,
        sourcePath: absolutePath,
        query,
        queryString,
        props: { frontmatter, pages: contentPages, term, pagination },
      })
    })
  })
}

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
    pages.set(source.absolutePath, {
      route,
      sourcePath: source.absolutePath,
      props,
    })
  }
}

const resolvePages = (sources) => {
  const pages = new Map()

  sources.forEach((source) => {
    addSourcePages(pages, sources, source)
  })

  return pages
}

// =====================================================
// PLUGIN
// =====================================================

const wilsonPlugin = () => {
  let options
  let sources
  let pages

  return {
    name: 'vite-plugin-wilson',
    enforce: 'pre',
    configResolved({ root }) {
      options = resolveOptions(root)
      debug.options(options)
      sources = resolveSources(options)
      debug.sources(sources)
      pages = resolvePages(sources)
      debug.pages(pages)
    },
    async handleHotUpdate(ctx) {
      const { filename } = splitId(ctx.file)
      if (isPage(filename)) {
        const content = await ctx.read(ctx.file)
        if (content === hotUpdateCache.get(ctx.file)) return
        hotUpdateCache.set(ctx.file, content)
        const frontmatter = parseFrontmatter(content, path.extname(ctx.file))
        const updatedSource = updateSource(sources, ctx.file, frontmatter)
        updateSourcePages(pages, sources, updatedSource)
        return ctx.modules
      }
    },
    resolveId(id) {
      if (id === MODULE_ID_VIRTUAL) {
        return id
      }
    },
    async load(id) {
      if (id === MODULE_ID_VIRTUAL) {
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
    },
    transform(code, id) {
      const { filename, rawQuery } = splitId(id)

      if (isPage(filename)) {
        let jsx

        if (isMarkdownPage(filename)) {
          const { content } = grayMatter(code)
          const html = md.render(content.replace(/^\n/, '').replace(/\n$/, ''))
          const props = { frontmatter: sources.get(filename).frontmatter }
          jsx = `
            import {h,Fragment} from "preact";
            import Layout from '${layoutPath}';
            const props=${JSON.stringify(props)};
            const Wrapper = () => <Layout {...props}>${html}</Layout>;
            export default Wrapper;
          `
        } else if (isJavascriptPage(filename)) {
          const props = getPageProps(pages, filename, rawQuery)
          jsx = `
            ${code}
            import Layout from '${layoutPath}';
            const props=${JSON.stringify(props)};
            const Wrapper = () => <Layout {...props}><Page {...props} /></Layout>;
            export default Wrapper;
          `
        }

        return transformJsx(jsx)
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
  plugins: [wilsonPlugin(), preact],
})
