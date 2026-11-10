import { describe, expect, it } from 'vitest'

import { clampLevel, LEVEL_META, levelColor, levelMeta, stageName } from './levels'

describe('分级口径', () => {
  it('五级齐全且顺序固定', () => {
    expect(LEVEL_META.map((l) => l.name)).toEqual(['平静', '关注', '预警', '高度预警', '警报'])
  })

  it('越界输入被夹到 0~4', () => {
    expect(clampLevel(-3)).toBe(0)
    expect(clampLevel(9)).toBe(4)
    expect(clampLevel(Number.NaN)).toBe(0)
    expect(levelColor(99)).toBe(LEVEL_META[4].color)
  })

  it('后端给了 stage 时以后端为准（避免两边口径漂移）', () => {
    expect(stageName(3, '高度预警')).toBe('高度预警')
    expect(stageName(3, '')).toBe('高度预警')
    expect(stageName(3, null)).toBe(levelMeta(3).name)
  })
})
