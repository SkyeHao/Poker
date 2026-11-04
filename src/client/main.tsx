import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { STYLES } from './styles.ts'

const storedTheme = localStorage.getItem('poker.theme')
if (storedTheme === 'dark' || storedTheme === 'light') {
  document.documentElement.dataset.theme = storedTheme
} else {
  document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const style = document.createElement('style')
style.dataset.pokerStyles = 'true'
style.textContent = STYLES
document.head.appendChild(style)

const root = document.getElementById('root')
if (root === null) throw new Error('Missing #root element')
createRoot(root).render(<App />)
