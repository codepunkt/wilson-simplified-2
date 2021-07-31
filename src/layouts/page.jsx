const PageLayout = ({ children, frontmatter }) => {
  return (
    <>
      <a href="/">Home</a>
      <a href="/page1">Page1</a>
      <a href="/page2">Page2</a>
      <a href="/page3">Page3</a>
      {children}
      <pre>{JSON.stringify(frontmatter, null, 2)}</pre>
    </>
  )
}

export default PageLayout
