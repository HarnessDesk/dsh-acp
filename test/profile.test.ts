import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const profile = readFileSync(resolve(import.meta.dirname, '../profile/harnessdesk.patch.yml'), 'utf8')

describe('the shipped HarnessDesk profile', () => {
  it('defaults to the current Flash route and offers Pro beside it', () => {
    expect(profile).toMatch(/model:\s*deepseek-flash\s*\n/)
    expect(profile).toMatch(/models:\s*\n\s+- deepseek-flash\s*\n\s+- deepseek-v4-pro\s*\n/)
    expect(profile).not.toMatch(/deepseek-v4-flash/)
  })
})
