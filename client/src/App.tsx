import { Navigate, Route, Routes } from 'react-router-dom'
import Home from './pages/Home'
import Game from './pages/Game'
import Auth from './pages/Auth'
import Profile from './pages/Profile'
import { AuthProvider } from './hooks/AuthProvider'
import { DialogProvider } from './hooks/DialogProvider'
import './App.css'

function App() {
  return (
    <DialogProvider>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Auth />} />
          <Route path="/games/:id" element={<Game />} />
          <Route path="/profile/:id" element={<Profile />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </DialogProvider>
  )
}

export default App
