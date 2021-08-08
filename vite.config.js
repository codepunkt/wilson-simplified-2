import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import grayMatter from 'gray-matter'
import MarkdownIt from 'markdown-it'
import { transform } from 'sucrase'
import path from 'path'
import fs from 'fs'
import { walk } from 'estree-walker'
import { parse as parseQueryString, stringify as stringifyQuery } from 'qs'
import { parse as parseJavaScript } from 'acorn'
import { generate } from 'astring'
import klawSync from 'klaw-sync'
import slugify from 'slugify'

const md = new MarkdownIt()

const frontmatterCache = new Map()
const hotUpdateCache = new Map()
const contentPagesCache = new Map()
const pageExtensions = ['.jsx', '.md']
const pageDirectory = path.join(process.cwd(), 'src', 'pages')
const layoutPath = path.join(process.cwd(), 'src', 'layouts', 'page.jsx')
const pageSize = 2

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

const getShortName = (file, root) => {
  return file.startsWith(root + '/') ? path.posix.relative(root, file) : file
}

const isPage = (filename) => {
  const extension = path.extname(filename)
  return (
    filename.startsWith(pageDirectory) && pageExtensions.includes(extension)
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

const readPagefiles = () => {
  return klawSync(pageDirectory, { nodir: true })
}

const splitId = (id) => {
  const [filename, rawQuery] = id.split('?', 2)
  return { filename, rawQuery }
}

const hasIntersection = (arr1, arr2) => {
  return arr1.filter((v) => arr2.includes(v)).length > 0
}

const wrapLayout = (wrapped, layoutProps = {}) => {
  return `import Layout from '${layoutPath}';const Wrapper=()=><Layout {...${JSON.stringify(
    layoutProps
  )}}>${wrapped}</Layout>;export default Wrapper;`
}

const getTaxonomyTerms = (taxonomyName) => {
  return [
    ...new Set(
      Array.from(frontmatterCache.entries())
        .map(([, fm]) => (fm.taxonomies ?? {})[taxonomyName] || [])
        .flat()
    ),
  ]
}

const getContentPages = (filename, taxonomyName, terms) => {
  const cacheKey = `${filename}:${terms.join(';')}`
  if (!contentPagesCache.has(cacheKey)) {
    contentPagesCache.set(
      cacheKey,
      Array.from(frontmatterCache.entries())
        .map(([f, fm]) => {
          return isContentPage(fm.type) &&
            hasIntersection((fm.taxonomies ?? {})[taxonomyName] ?? [], terms)
            ? { route: pagePathToRoute(f), frontmatter: fm }
            : null
        })
        .filter(Boolean)
    )
  }
  return contentPagesCache.get(cacheKey)
}

const replaceTerm = (string, term) => {
  return string.replace(/\${term}/, term)
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
  const extensionRegexp = new RegExp(`(${pageExtensions.join('|')})$`)
  const withoutExtension = relativePath.replace(extensionRegexp, '')
  const withoutIndex = withoutExtension.replace(/\/?index$/, '')
  return `/${withoutIndex}/`.replace(/\/\//g, '/')
}

const createPaginatedRoute = (route, pageNumber) => {
  return `${route}${pageNumber === 1 ? '' : `page-${pageNumber}/`}`
}

const getFrontmatter = (filename, term = false) => {
  if (!frontmatterCache.has(filename)) {
    const code = fs.readFileSync(filename, 'utf-8')
    const extension = path.extname(filename)
    const parsed = parseFrontmatter(code, extension)
    frontmatterCache.set(filename, parsed)
  }
  const frontmatter = frontmatterCache.get(filename)
  return term
    ? {
        ...frontmatter,
        title: replaceTerm(frontmatter.title, term),
        permalink: replaceTerm(frontmatter.permalink, toSlug(term)),
      }
    : frontmatter
}

const createPagination = (baseRoute, currentPage, numPages) => {
  return {
    currentPage,
    previousPage:
      currentPage === 1
        ? undefined
        : createPaginatedRoute(baseRoute, currentPage - 1),
    nextPage:
      currentPage === Math.ceil(numPages / pageSize)
        ? undefined
        : createPaginatedRoute(baseRoute, currentPage + 1),
  }
}

const getPageProps = (filename, queryString) => {
  const { currentPage, selectedTerm } = parseQueryString(queryString)
  const page = Number(currentPage)
  const frontmatter = getFrontmatter(filename)
  const props = { frontmatter }
  const { taxonomyName, selectedTerms } = frontmatter

  if (frontmatter.type === 'terms') {
    props.terms = getTaxonomyTerms(taxonomyName).map((term) => ({
      term,
      slug: toSlug(term),
    }))
  } else if (frontmatter.type === 'select') {
    const contentPages = getContentPages(filename, taxonomyName, selectedTerms)
    props.pages = contentPages.slice((page - 1) * pageSize, page * pageSize)
    props.pagination = createPagination(
      pagePathToRoute(filename),
      page,
      contentPages.length
    )
  } else if (frontmatter.type === 'taxonomy') {
    const contentPages = getContentPages(filename, taxonomyName, [selectedTerm])
    props.frontmatter = getFrontmatter(filename, selectedTerm)
    props.pages = contentPages.slice((page - 1) * pageSize, page * pageSize)
    props.pagination = createPagination(
      props.frontmatter.permalink,
      page,
      contentPages.length
    )
  }

  return props
}

const getRoutes = () => {
  let routes = []

  readPagefiles().forEach(({ path: pagePath }) => {
    const fm = getFrontmatter(pagePath)
    const getChunkedContentPages = (terms) =>
      chunkArray(getContentPages(pagePath, fm.taxonomyName, terms), pageSize)

    if (fm.type === 'taxonomy') {
      getTaxonomyTerms(fm.taxonomyName).forEach((term) => {
        const contentPages = getChunkedContentPages([term])
        contentPages.forEach((_, i) => {
          const queryString = stringifyQuery({
            selectedTerm: term,
            currentPage: i + 1,
          })
          routes.push({
            module: `${pagePath}?${queryString}`,
            path: createPaginatedRoute(
              replaceTerm(fm.permalink, toSlug(term)),
              i + 1
            ),
          })
        })
      })
    } else if (fm.type === 'select') {
      const contentPages = getChunkedContentPages(fm.selectedTerms)
      contentPages.forEach((_, i) => {
        const queryString = stringifyQuery({ currentPage: i + 1 })
        routes.push({
          module: `${pagePath}?${queryString}`,
          path: createPaginatedRoute(pagePathToRoute(pagePath), i + 1),
        })
      })
    } else {
      routes.push({ module: pagePath, path: pagePathToRoute(pagePath) })
    }
  })

  return routes
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

export default defineConfig({
  clearScreen: false,
  esbuild: {
    jsxInject: `import { h, Fragment } from 'preact'`,
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
  },
  plugins: [
    {
      name: 'routes',
      resolveId(id) {
        return id.startsWith('virtual:routes') ? id : undefined
      },
      async load(id) {
        if (!id.startsWith('virtual:routes')) return
        const routes = getRoutes()
        const code = `
          import { h } from 'preact';
          import { lazy } from 'preact-iso';
          ${routes
            .map(
              ({ module }, i) =>
                `const Page_${i} = lazy(() => import('${module}'));`
            )
            .join('')}
          export default [${routes
            .map(({ path }, i) => `h(Page_${i},{path:'${path}'})`)
            .join(',')}];
        `
        return code
      },
    },
    {
      name: 'md-pages',
      async handleHotUpdate(ctx) {
        const { filename } = splitId(ctx.file)
        if (isMarkdownPage(filename)) {
          const content = await ctx.read(ctx.file)
          if (content === hotUpdateCache.get(ctx.file)) return
          const frontmatter = parseFrontmatter(content, '.md')
          frontmatterCache.set(ctx.file, frontmatter)
          hotUpdateCache.set(ctx.file, content)
          return ctx.modules
        }
      },
      transform(code, id) {
        const { filename } = splitId(id)
        if (isMarkdownPage(filename)) {
          const { content } = grayMatter(code)
          const html = md.render(content.replace(/^\n/, '').replace(/\n$/, ''))
          const frontmatter = getFrontmatter(filename)
          const jsx = `import {h,Fragment} from "preact";const Page=()=>(<>${html}</>);${wrapLayout(
            `<Page frontmatter={${JSON.stringify(frontmatter)}}/>`,
            { frontmatter }
          )}`
          const preact = transformJsx(jsx)
          return preact
        }
      },
    },
    {
      name: 'js-pages',
      async handleHotUpdate(ctx) {
        const { filename } = splitId(ctx.file)
        if (isJavascriptPage(filename)) {
          const content = await ctx.read(ctx.file)
          if (content !== hotUpdateCache.get(ctx.file)) {
            const frontmatter = parseFrontmatter(content, '.jsx')
            frontmatterCache.set(ctx.file, frontmatter)
            hotUpdateCache.set(ctx.file, content)
          }
          return ctx.modules
        }
      },
      transform(code, id) {
        const { filename, rawQuery } = splitId(id)
        if (isJavascriptPage(filename)) {
          const props = getPageProps(filename, rawQuery)
          const jsx = `${code}const props=${JSON.stringify(props)};${wrapLayout(
            `<Page {...props} />`,
            props
          )}`
          const preact = transformJsx(jsx)
          return preact
        }
      },
    },
    {
      name: 'frontmatter',
      async configResolved() {
        for (const { path: pagePath } of readPagefiles()) {
          const code = fs.readFileSync(pagePath, 'utf-8')
          const extension = path.extname(pagePath)
          const frontmatter = parseFrontmatter(code, extension)
          frontmatterCache.set(pagePath, frontmatter)
        }
      },
    },
    preact,
  ],
})
