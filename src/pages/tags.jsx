export const Page = ({ frontmatter, terms }) => {
  return (
    <>
      <h1>{frontmatter.title}</h1>
      <ul>
        {terms.map(({ term, slug }) => (
          <li>
            <a href={`/tag/${slug}/`}>{term}</a>
          </li>
        ))}
      </ul>
    </>
  )
}

export const frontmatter = {
  type: 'terms',
  title: 'Tags',
  taxonomyName: 'tags',
}
