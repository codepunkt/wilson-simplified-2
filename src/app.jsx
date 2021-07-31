import { ErrorBoundary, LocationProvider, Router } from 'preact-iso'
import routes from 'virtual:routes'

const NotFound = () => <>Not Found</>

export function App() {
  return (
    <LocationProvider>
      <div>
        <ErrorBoundary>
          <a href="/">Home</a>
          <a href="/page1">Page1</a>
          <a href="/page2">Page2</a>
          <a href="/page3">Page3</a>
          <Router>{[...routes, <NotFound key="notFound" default />]}</Router>
        </ErrorBoundary>
      </div>
    </LocationProvider>
  )
}
