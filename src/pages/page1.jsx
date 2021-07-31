const Page1 = ({ frontmatter }) => (
  <>
    <h1>Page 1</h1>
    <div>{JSON.stringify(frontmatter)}</div>
  </>
)

export default Page1

export const frontmatter = {
  type: 'select',
  selectedTerms: ['writing'],
  taxonomyName: 'categories',
}
