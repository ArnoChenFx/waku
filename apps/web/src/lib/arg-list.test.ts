import { describe, expect, test } from 'bun:test'
import { normalizeProviderArgs, parseArgList } from './arg-list'

describe('parseArgList', () => {
  test('splits on whitespace and trims outer padding', () => {
    expect(parseArgList('')).toEqual([])
    expect(parseArgList('   ')).toEqual([])
    expect(parseArgList('--profile  work')).toEqual(['--profile', 'work'])
    expect(parseArgList('  -v --json  ')).toEqual(['-v', '--json'])
  })

  test('keeps quoted segments together and drops the quotes', () => {
    expect(parseArgList('--config "my dir" -v')).toEqual(['--config', 'my dir', '-v'])
    expect(parseArgList('"--flag"')).toEqual(['--flag'])
  })

  test('treats an unmatched quote as delimiting nothing', () => {
    expect(parseArgList('--path "unclosed')).toEqual(['--path', 'unclosed'])
  })

  test('parses the codex profile example from the docs', () => {
    expect(parseArgList('--profile work')).toEqual(['--profile', 'work'])
  })
})

describe('normalizeProviderArgs', () => {
  test('keeps distinct argv lists apart', () => {
    expect(normalizeProviderArgs(['a b'])).not.toEqual(normalizeProviderArgs(['a', 'b']))
    expect(normalizeProviderArgs(undefined)).toEqual(normalizeProviderArgs([]))
    expect(normalizeProviderArgs(['--profile', 'work'])).toEqual('["--profile","work"]')
  })
})
