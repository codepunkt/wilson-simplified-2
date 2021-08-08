export const Page = ({ frontmatter, pages, pagination }) => {
  return (
    <>
      <h1>{frontmatter.title}</h1>
      <ul>
        {pages.map((page) => (
          <li>
            <a href={page.route}>{page.frontmatter.title}</a>
          </li>
        ))}
      </ul>
      {pagination.previousPage && (
        <a href={pagination.previousPage}>Previous</a>
      )}
      {pagination.nextPage && <a href={pagination.nextPage}>Next</a>}
    </>
  )
}

export const frontmatter = {
  type: 'taxonomy',
  taxonomyName: 'tags',
  title: 'Tag: ${term}',
  permalink: '/tag/${term}/',
}
