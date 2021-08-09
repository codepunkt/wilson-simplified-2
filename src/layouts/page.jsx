const PageLayout = ({
  children,
  frontmatter,
  pages,
  pagination,
  selectedTerm,
  terms,
}) => {
  return (
    <>
      <nav>
        <style>{`
          body { min-height: 100vh; }
          nav > a { margin-right: 8px; }
          pre { background: #f4f4f4; padding: 0.5rem; }
          footer { font-size: 12px; position: absolute; bottom: 10px; right: 10px; left: 10px; background: #dbe6ff; color: #333; }
          footer > pre { background: inherit; margin: 0; }
          footer > h4 { margin: 0; font-size: 12px; padding: 0.5rem; text-transform: uppercase; color: #677daf; font-family: Verdana,Arial,sans-serif; }
        `}</style>
        <a href="/">Home</a>
        <a href="/blog/">Blog Posts</a>
        <a href="/tags/">Tags</a>
      </nav>
      {children}
      <footer>
        <h4>Current props</h4>
        <pre>
          frontmatter = {JSON.stringify(frontmatter, null, 2)}
          {terms && `\n\nterms = ${JSON.stringify(terms, null, 2)}`}
          {selectedTerm && `\n\nselectedTerm = ${selectedTerm}`}
          {pagination &&
            `\n\npagination = ${JSON.stringify(pagination, null, 2)}`}
        </pre>
      </footer>
    </>
  )
}

export default PageLayout
