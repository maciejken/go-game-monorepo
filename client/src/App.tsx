import { Navigate, Route, Routes } from 'react-router-dom'
import Home from './pages/Home'
import Game from './pages/Game'
import './App.css'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/games/:id" element={<Game />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
