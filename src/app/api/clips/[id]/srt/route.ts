import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { buildSrt } from '@/lib/srt'
import { sanitize, slugify } from '@/lib/http'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const clip = getStore().getClip(id)

  if (!clip) return NextResponse.json({ error: 'No such clip' }, { status: 404 })

  return new Response(buildSrt(clip.words), {
    headers: {
      'Content-Type': 'application/x-subrip; charset=utf-8',
      'Content-Disposition': `attachment; filename="${sanitize(`${slugify(clip.title)}.srt`)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
