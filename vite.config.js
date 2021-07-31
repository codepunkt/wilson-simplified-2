import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import grayMatter from 'gray-matter'
import MarkdownIt from 'markdown-it'
import { transform } from 'sucrase'
import path from 'path'
import fs from 'fs'
import { walk } from 'estree-walker'
// import { parse as parseQueryString } from 'qs'
import { parse as parseJavaScript } from 'acorn'
import { generate } from 'astring'
import klawSync from 'klaw-sync'

const md = new MarkdownIt()

const pageSchema = 'page:'
const jsxPageSchema = 'jsx-page:'
const mdPageSchema = 'md-page:'
const frontmatterCache = new Map()
const pageExtensions = ['.jsx', '.md']
const pageDirectory = path.join(process.cwd(), 'src', 'pages')

const isPage = (id) => {
  const [file] = id.split('?')
  const extension = path.extname(file)
  return file.startsWith(pageDirectory) && pageExtensions.includes(extension)
    ? extension
    : false
}

const wrapLayout = (wrapped) => {
  const layoutPath = path.join(process.cwd(), 'src', 'layouts', 'page.jsx')
  return `import Layout from '${layoutPath}';const Wrapper=()=><Layout>${wrapped}</Layout>;export default Wrapper;`
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
        const code = `
          import { h } from 'preact';
          import { lazy } from 'preact-iso';
          const Page2 = lazy(() => import('./src/pages/page2.md'));
          const Page3 = lazy(() => import('./src/pages/page3.md'));
          const Page1 = lazy(() => import('./src/pages/page1?page=1'));
          export default [h(Page1,{path:'/page1'}),h(Page2,{path:'/page2'}),h(Page3,{path:'/page3'})];
        `
        return code
      },
    },
    // has to be before 'pages' plugin
    {
      name: 'md-pages',
      // resolveId(id) {
      //   if (isPage(id) === '.md') {
      //     return id
      //   }
      // },
      transform(code, id) {
        if (isPage(id) === '.md') {
          const { content } = grayMatter(code)
          const html = md.render(content.replace(/^\n/, '').replace(/\n$/, ''))
          const [file] = id.split('?')
          const jsx = `import {h,Fragment} from "preact";const Page=()=>(<>${html}</>);${wrapLayout(
            `<Page frontmatter={${JSON.stringify(
              frontmatterCache.get(file)
            )}}/>`
          )};`
          const preact = transform(jsx, {
            transforms: ['jsx'],
            production: true,
            jsxPragma: 'h',
            jsxFragmentPragma: 'Fragment',
          }).code
          return {
            code: preact,
          }
        }
      },
    },
    {
      name: 'js-pages',
      // resolveId(id) {
      //   if (isPage(id) === '.jsx') {
      //     return id
      //   }
      // },
      transform(code, id) {
        if (isPage(id) === '.jsx') {
          const [file, queryString] = id.split('?')
          // const query = parseQueryString(queryString)
          const frontmatter = frontmatterCache.get(file)
          const props = { frontmatter }
          const preact = transform(
            `${code}const props=${JSON.stringify(props)};${wrapLayout(
              `<Page {...props} />`
            )}`,
            {
              transforms: ['jsx'],
              production: true,
              jsxPragma: 'h',
              jsxFragmentPragma: 'Fragment',
            }
          ).code
          console.log({ preact })
          return {
            code: preact,
          }
        }
      },
    },
    {
      name: 'frontmatter',
      async configResolved() {
        for (const { path: pagePath } of klawSync(pageDirectory, {
          nodir: true,
        })) {
          const code = fs.readFileSync(pagePath, 'utf-8')
          const extension = path.extname(pagePath)
          if (extension === '.md') {
            const { data } = grayMatter(code)
            frontmatterCache.set(pagePath, data)
          } else if (extension === '.jsx') {
            const js = transform(code, {
              transforms: ['jsx'],
              production: true,
              jsxPragma: 'h',
              jsxFragmentPragma: 'Fragment',
            }).code
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
            frontmatterCache.set(pagePath, data)
          }
        }
      },
    },

    preact,
  ],
})
