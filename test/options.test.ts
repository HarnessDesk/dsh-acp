import { describe, expect, it } from 'vitest'
import { sessionConfigOptions } from '../src/options.ts'

describe('DeepSeek model options', () => {
  it('labels the current model routes and defaults to V4.1 Flash', () => {
    const model = sessionConfigOptions({
      model: 'deepseek-flash',
      models: ['deepseek-flash', 'deepseek-v4-pro'],
    }).find((option) => option.id === 'model')

    expect(model).toMatchObject({
      currentValue: 'deepseek-flash',
      options: [
        { value: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
        { value: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    })
  })

  it('keeps the legacy Flash route readable when a historical composition offers it', () => {
    const model = sessionConfigOptions({
      model: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    }).find((option) => option.id === 'model')

    expect(model?.options[0]).toEqual({ value: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' })
  })
})
