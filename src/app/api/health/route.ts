import { NextResponse } from 'next/server'
import { resolveLlmConfig } from '@/lib/config'
import { probeConfig } from '@/lib/probe'

export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json(await probeConfig(resolveLlmConfig()))
}
