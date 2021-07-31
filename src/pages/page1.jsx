export const Page = ({ contentPages, frontmatter }) => (
  <>
    <h1>{frontmatter.title}</h1>
    {contentPages && (
      <ul>
        {contentPages.map((cp) => (
          <li>{JSON.stringify(cp)}</li>
        ))}
      </ul>
    )}
  </>
)

export const frontmatter = {
  title: 'Page 1',
  type: 'select',
  selectedTerms: ['writing'],
  taxonomyName: 'categories',
}
