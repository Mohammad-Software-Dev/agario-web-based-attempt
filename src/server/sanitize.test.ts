import { describe, expect, it } from 'vitest';
import { sanitizeName } from './sanitize.js';
describe('sanitizeName',()=>{it('removes control/html delimiters and caps length',()=>{expect(sanitizeName('<b>\u0000A very very very long player name</b>')).not.toContain('<');expect(sanitizeName('x'.repeat(50))).toHaveLength(20)});it('falls back for blank values',()=>expect(sanitizeName('   ')).toBe('Cell'))});
