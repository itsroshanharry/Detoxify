'use client'

import { useState } from 'react'
import { useSession, signOut } from "next-auth/react"
import { useRouter } from 'next/navigation'

export default function Home() {
  const router = useRouter()
  const { data: session, status } = useSession()
  const [topic, setTopic] = useState('')
  const [processing, setProcessing] = useState(false)

  if (status === 'loading') {
    return <div>Loading...</div>
  }

  if (status === 'unauthenticated') {
    router.push('/login')
    return null
  }

  const handleProcess = async () => {
    if (!session) {
      alert('Please sign in first')
      return
    }

    setProcessing(true)
    try {
      const res = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic })
      })
      const data = await res.json()
      alert(data.message)
    } catch (error) {
      console.error('Error:', error)
      alert('An error occurred during processing')
    }
    setProcessing(false)
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen py-2">
      <h1 className="text-4xl font-bold mb-6">YouTube Automation Dashboard</h1>
      <p className="mb-4">Signed in as {session?.user?.email}</p>
      <div className="mb-4">
        <input 
          type="text" 
          value={topic} 
          onChange={(e) => setTopic(e.target.value)} 
          placeholder="Enter topic"
          className="px-4 py-2 border border-gray-300 rounded-lg mr-2"
        />
        <button 
          onClick={handleProcess} 
          disabled={processing}
          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-blue-300"
        >
          {processing ? 'Processing...' : 'Process Videos'}
        </button>
      </div>
      <button 
        onClick={() => signOut({ callbackUrl: '/login' })}
        className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600"
      >
        Sign out
      </button>
    </div>
  )
}