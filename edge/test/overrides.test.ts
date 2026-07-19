import { describe, it, expect } from 'vitest'
import { extractMessageOverrides } from '../src/slack/overrides'

describe('overrides', () => {
  describe('Claudex harness', () => {
    it('--claudex selects Claude Code through CLIProxyAPI', () => {
      const result = extractMessageOverrides('--claudex Use ChatGPT')
      expect(result.harnessType).toBe('claudex')
      expect(result.cleanedText).toBe('Use ChatGPT')
    })

    it('--model gpt-* implies Claudex', () => {
      const result = extractMessageOverrides('--model gpt-5.6-sol Reply briefly')
      expect(result.harnessType).toBe('claudex')
      expect(result.model).toBe('gpt-5.6-sol')
    })
  })

  describe('model shortcuts', () => {
    it('--sonnet sets model claude-sonnet-5 + harnessType claudecode and strips the flag', () => {
      const result = extractMessageOverrides('--sonnet What is 2+2?')
      expect(result.model).toBe('claude-sonnet-5')
      expect(result.harnessType).toBe('claudecode')
      expect(result.cleanedText).toBe('What is 2+2?')
    })

    it('--opus sets model claude-opus-4-8 + harnessType claudecode', () => {
      const result = extractMessageOverrides('--opus Tell me a story')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.harnessType).toBe('claudecode')
      expect(result.cleanedText).toBe('Tell me a story')
    })

    it('--fable sets model claude-fable-5 + harnessType claudecode', () => {
      const result = extractMessageOverrides('--fable Hello')
      expect(result.model).toBe('claude-fable-5')
      expect(result.harnessType).toBe('claudecode')
      expect(result.cleanedText).toBe('Hello')
    })

    it('--haiku sets model claude-haiku-4-5-20251001 + harnessType claudecode', () => {
      const result = extractMessageOverrides('--haiku Quick answer')
      expect(result.model).toBe('claude-haiku-4-5-20251001')
      expect(result.harnessType).toBe('claudecode')
      expect(result.cleanedText).toBe('Quick answer')
    })
  })

  describe('--model flag', () => {
    it('--model opus expands the alias', () => {
      const result = extractMessageOverrides('--model opus What should I do?')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.cleanedText).toBe('What should I do?')
    })

    it('--model=opus (with equals) expands the alias', () => {
      const result = extractMessageOverrides('--model=opus What should I do?')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.cleanedText).toBe('What should I do?')
    })

    it('--model claude-opus-4-8 passes through without expansion', () => {
      const result = extractMessageOverrides('--model claude-opus-4-8 Hello')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.cleanedText).toBe('Hello')
    })

    it('--model claude-sonnet-5 passes through', () => {
      const result = extractMessageOverrides('--model claude-sonnet-5 Test')
      expect(result.model).toBe('claude-sonnet-5')
      expect(result.cleanedText).toBe('Test')
    })

    it('handles model with underscores and dashes in full model id', () => {
      const result = extractMessageOverrides('--model my-custom_model-v1.5 Text')
      expect(result.model).toBe('my-custom_model-v1.5')
      expect(result.cleanedText).toBe('Text')
    })
  })

  describe('reasoning effort', () => {
    it('-rsn high normalizes correctly', () => {
      const result = extractMessageOverrides('-rsn high Think deeply')
      expect(result.reasoning).toBe('high')
      expect(result.cleanedText).toBe('Think deeply')
    })

    it('-rsn=hi normalizes to high', () => {
      const result = extractMessageOverrides('-rsn=hi Analyze')
      expect(result.reasoning).toBe('high')
      expect(result.cleanedText).toBe('Analyze')
    })

    it('-rsn med normalizes to medium', () => {
      const result = extractMessageOverrides('-rsn med Consider')
      expect(result.reasoning).toBe('medium')
      expect(result.cleanedText).toBe('Consider')
    })

    it('-rsn min normalizes to minimal', () => {
      const result = extractMessageOverrides('-rsn min Quick')
      expect(result.reasoning).toBe('minimal')
      expect(result.cleanedText).toBe('Quick')
    })

    it('-rsn xhigh normalizes correctly', () => {
      const result = extractMessageOverrides('-rsn xhigh Deep think')
      expect(result.reasoning).toBe('xhigh')
      expect(result.cleanedText).toBe('Deep think')
    })

    it('-rsn x-high normalizes to xhigh', () => {
      const result = extractMessageOverrides('-rsn x-high Reason')
      expect(result.reasoning).toBe('xhigh')
      expect(result.cleanedText).toBe('Reason')
    })

    it('-rsn max works', () => {
      const result = extractMessageOverrides('-rsn max Ultimate')
      expect(result.reasoning).toBe('max')
      expect(result.cleanedText).toBe('Ultimate')
      expect(result.errors).toEqual([
        '-rsn max is unsupported; Claudex reasoning effort is controlled by the proxy configuration'
      ])
    })

    it('-rsn none works', () => {
      const result = extractMessageOverrides('-rsn none No effort')
      expect(result.reasoning).toBe('none')
      expect(result.cleanedText).toBe('No effort')
    })

    it('-rsn with unknown value is stripped and rejected', () => {
      const result = extractMessageOverrides('-rsn unknown Text')
      expect(result.reasoning).toBeUndefined()
      expect(result.cleanedText).toBe('Text')
      expect(result.errors).toEqual(['unsupported reasoning effort: unknown'])
    })
  })

  describe('harness flags', () => {
    it('--claude sets harnessType claudecode', () => {
      const result = extractMessageOverrides('--claude Message')
      expect(result.harnessType).toBe('claudecode')
      expect(result.cleanedText).toBe('Message')
    })

    it('--claude-code sets harnessType claudecode', () => {
      const result = extractMessageOverrides('--claude-code Message')
      expect(result.harnessType).toBe('claudecode')
      expect(result.cleanedText).toBe('Message')
    })

    it('--claudecode sets harnessType claudecode', () => {
      const result = extractMessageOverrides('--claudecode Message')
      expect(result.harnessType).toBe('claudecode')
      expect(result.cleanedText).toBe('Message')
    })

    it('--codex is stripped and rejected', () => {
      const result = extractMessageOverrides('--codex Message')
      expect(result.harnessType).toBeUndefined()
      expect(result.cleanedText).toBe('Message')
      expect(result.errors).toEqual([
        '--codex is unsupported; use --claudex to run Claude Code with a Codex-backed model'
      ])
    })
  })

  describe('removed provider flags', () => {
    it('--bedrock is NOT recognized and remains in text', () => {
      const result = extractMessageOverrides('--bedrock Use bedrock')
      expect(result.harnessType).toBeUndefined()
      expect(result.cleanedText).toBe('--bedrock Use bedrock')
    })

    it('--meta is NOT recognized and remains in text', () => {
      const result = extractMessageOverrides('--meta Use meta')
      expect(result.harnessType).toBeUndefined()
      expect(result.cleanedText).toBe('--meta Use meta')
    })

    it('--amp is NOT recognized and remains in text', () => {
      const result = extractMessageOverrides('--amp Go fast')
      expect(result.harnessType).toBeUndefined()
      expect(result.cleanedText).toBe('--amp Go fast')
    })
  })

  describe('flag stripping and cleanedText', () => {
    it('flags embedded mid-sentence strip cleanly', () => {
      const result = extractMessageOverrides('Can you --sonnet explain this?')
      expect(result.cleanedText).toBe('Can you explain this?')
    })

    it('multiple flags all strip correctly', () => {
      const result = extractMessageOverrides('--sonnet --codex -rsn high What?')
      expect(result.harnessType).toBe('claudecode')
      expect(result.model).toBe('claude-sonnet-5')
      expect(result.reasoning).toBe('high')
      expect(result.cleanedText).toBe('What?')
      expect(result.errors).toHaveLength(2)
    })

    it('text with no flags returns same reference (cleanedText === input)', () => {
      const input = 'Just a plain message'
      const result = extractMessageOverrides(input)
      expect(result.cleanedText).toBe(input)
      expect(result.cleanedText === input).toBe(true)
    })

    it('text with only whitespace changes returns trimmed version', () => {
      const result = extractMessageOverrides('--sonnet   ')
      expect(result.cleanedText).toBe('')
    })

    it('flag at start of message', () => {
      const result = extractMessageOverrides('--sonnet Hello world')
      expect(result.cleanedText).toBe('Hello world')
    })

    it('flag at end of message', () => {
      const result = extractMessageOverrides('Hello world --sonnet')
      expect(result.cleanedText).toBe('Hello world')
    })

    it('flag alone', () => {
      const result = extractMessageOverrides('--sonnet')
      expect(result.cleanedText).toBe('')
      expect(result.model).toBe('claude-sonnet-5')
    })

    it('multiple spaces between flag and text collapse to single space', () => {
      const result = extractMessageOverrides('--sonnet    Hello')
      expect(result.cleanedText).toBe('Hello')
    })

    it('flag followed by newline then text', () => {
      const result = extractMessageOverrides('--sonnet\nHello')
      expect(result.cleanedText).toBe('Hello')
    })

    it('text before flag', () => {
      const result = extractMessageOverrides('Hello --sonnet world')
      expect(result.cleanedText).toBe('Hello world')
    })

    it('multiple flags in sequence', () => {
      const result = extractMessageOverrides('--sonnet --claude-code Start text')
      // Both set claudecode, last one wins (claude-code)
      expect(result.harnessType).toBe('claudecode')
      expect(result.cleanedText).toBe('Start text')
    })
  })

  describe('preserved content protection', () => {
    it('URL with dashes is not mangled', () => {
      const result = extractMessageOverrides('Check out https://my-api-gateway.example.com')
      expect(result.cleanedText).toBe('Check out https://my-api-gateway.example.com')
      expect(result.harnessType).toBeUndefined()
    })

    it('email with dashes is not mangled', () => {
      const result = extractMessageOverrides('Contact my-support-team@example.com')
      expect(result.cleanedText).toBe('Contact my-support-team@example.com')
    })

    it('hyphenated word is not treated as flag', () => {
      const result = extractMessageOverrides('The well-known issue')
      expect(result.cleanedText).toBe('The well-known issue')
      expect(result.harnessType).toBeUndefined()
    })

    it('word starting with single dash is not stripped', () => {
      const result = extractMessageOverrides('Explain the -x flag behavior')
      expect(result.cleanedText).toBe('Explain the -x flag behavior')
      expect(result.harnessType).toBeUndefined()
    })
  })

  describe('model value boundary', () => {
    it('newline after model value starts the prompt', () => {
      const result = extractMessageOverrides('--model opus\nWhat is AI?')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.cleanedText).toBe('What is AI?')
    })

    it('carriage return after model value handled', () => {
      const result = extractMessageOverrides('--model opus\r\nExplain')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.cleanedText).toBe('Explain')
    })

    it('space after model value', () => {
      const result = extractMessageOverrides('--model opus Explain')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.cleanedText).toBe('Explain')
    })

    it('equals sign with spaces', () => {
      const result = extractMessageOverrides('--model = opus Explain')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.cleanedText).toBe('Explain')
    })

    it('<br/> tag after model value', () => {
      const result = extractMessageOverrides('--model opus<br/>Explain')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.cleanedText).toBe('Explain')
    })

    it('end of string after model value', () => {
      const result = extractMessageOverrides('--model opus')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.cleanedText).toBe('')
    })
  })

  describe('case insensitivity', () => {
    it('--SONNET works', () => {
      const result = extractMessageOverrides('--SONNET Hello')
      expect(result.model).toBe('claude-sonnet-5')
    })

    it('--OpUs works', () => {
      const result = extractMessageOverrides('--OpUs Hello')
      expect(result.model).toBe('claude-opus-4-8')
    })

    it('-RSN HIGH works', () => {
      const result = extractMessageOverrides('-RSN HIGH Think')
      expect(result.reasoning).toBe('high')
    })

    it('--MODEL opus works', () => {
      const result = extractMessageOverrides('--MODEL opus Analyze')
      expect(result.model).toBe('claude-opus-4-8')
    })
  })

  describe('combined flags', () => {
    it('model shortcut + reasoning', () => {
      const result = extractMessageOverrides('--sonnet -rsn high Complex problem')
      expect(result.model).toBe('claude-sonnet-5')
      expect(result.reasoning).toBe('high')
      expect(result.harnessType).toBe('claudecode')
      expect(result.cleanedText).toBe('Complex problem')
    })

    it('explicit model + reasoning + harness', () => {
      const result = extractMessageOverrides('--model opus -rsn med --codex Question?')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.reasoning).toBe('medium')
      expect(result.harnessType).toBe('claudecode')
      expect(result.cleanedText).toBe('Question?')
      expect(result.errors).toHaveLength(2)
    })

    it('harness flag + model shortcut (shortcut wins for model)', () => {
      const result = extractMessageOverrides('--codex --sonnet Message')
      expect(result.harnessType).toBe('claudecode')
      expect(result.model).toBe('claude-sonnet-5')
      expect(result.cleanedText).toBe('Message')
      expect(result.errors).toHaveLength(1)
    })

    it('explicit model + model shortcut (explicit wins if first)', () => {
      const result = extractMessageOverrides('--model claude-fable-5 --sonnet Text')
      expect(result.model).toBe('claude-fable-5')
      expect(result.harnessType).toBe('claudecode')
      expect(result.cleanedText).toBe('Text')
    })
  })

  describe('no provider field in result', () => {
    it('extractMessageOverrides result does not have provider property', () => {
      const result = extractMessageOverrides('--model opus Message')
      expect('provider' in result).toBe(false)
    })

    it('result only has cleanedText, harnessType, model, reasoning', () => {
      const result = extractMessageOverrides('--sonnet -rsn high Text')
      const keys = Object.keys(result).sort()
      expect(keys).toEqual(['cleanedText', 'harnessType', 'model', 'reasoning'].sort())
    })
  })

  describe('whitespace handling', () => {
    it('leading and trailing spaces in text with flags are trimmed', () => {
      const result = extractMessageOverrides('  --sonnet   Hello world   ')
      expect(result.cleanedText).toBe('Hello world')
    })

    it('spaces around model value', () => {
      const result = extractMessageOverrides('--model  opus  Text')
      expect(result.model).toBe('claude-opus-4-8')
      expect(result.cleanedText).toBe('Text')
    })

    it('tabs are handled like spaces', () => {
      const result = extractMessageOverrides('--sonnet\tHello')
      expect(result.cleanedText).toBe('Hello')
    })
  })
})
