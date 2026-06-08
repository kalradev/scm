import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { removeSavedQuotesSeededFromPoNew } from './lib/savedQuotesStorage'
import './index.css'

removeSavedQuotesSeededFromPoNew()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
