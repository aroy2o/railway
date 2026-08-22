import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import './index.css'
import App from './App.tsx'
import { store } from './store/store.ts'

const container = document.getElementById('root')
if (!container) {
  // Fail loudly rather than rendering nothing if index.html ever changes.
  throw new Error('Root element #root not found in index.html')
}

createRoot(container).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
)
