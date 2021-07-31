import { ErrorBoundary, LocationProvider, Router } from 'preact-iso'
import routes from 'virtual:routes'
import PageLayout from './layouts/page'

const NotFound = () => <PageLayout>Not Found</PageLayout>

export function App() {
  return (
    <LocationProvider>
      <div>
        <ErrorBoundary>
          <Router>{[...routes, <NotFound key="notFound" default />]}</Router>
        </ErrorBoundary>
      </div>
    </LocationProvider>
  )
}
