import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { Viewer } from './Viewer'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Viewer />
  </StrictMode>
)
