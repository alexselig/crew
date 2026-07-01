import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Intentionally NOT wrapped in StrictMode: its double-invoked effects would
// open/dispose each xterm terminal twice, corrupting the persistent pool.
const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}
