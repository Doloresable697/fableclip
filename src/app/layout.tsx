import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'fableclip',
  description:
    'Paste a long video. Get vertical, captioned shorts, ranked by how likely they are to travel. Yours, on your machine.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
