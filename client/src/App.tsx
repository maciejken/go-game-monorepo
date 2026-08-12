import { useState } from 'react'
import Home from './pages/Home'
import Game from './pages/Game'
import './App.css'

function App() {
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null)

  if (selectedGameId) {
    return (
      <div>
        <button type="button" onClick={() => setSelectedGameId(null)}>
          Back to games
        </button>
        <Game gameId={selectedGameId} />
      </div>
    )
  }

  return <Home onSelectGame={setSelectedGameId} />
}

export default App
