import { describe, expect, it } from 'vitest'
import { suggestCategory, type CategoryMappingRule, type KeywordRule, KEYWORD_RULES } from '../src/categorize.js'

/** Fake category id lookup — canonical names → ids. */
function catId(name: string): string {
  return `cat-${name.toLowerCase().replace(/\s+/g, '-')}`
}

const categoryByName = new Map<string, string>(
  [
    'Fees', 'Transfer', 'Income', 'Groceries', 'Dining', 'Fast Food',
    'Rent', 'Mortgage', 'Utilities', 'Gas', 'Auto Insurance', 'Health Insurance',
    'Healthcare', 'Shopping', 'Entertainment', 'Subscriptions', 'Travel',
    'Pet Supplies', 'Investments', 'Credit Card Payment', 'Other',
  ].map((n) => [n, catId(n)]),
)

describe('suggestCategory', () => {
  describe('1. exact match', () => {
    it('matches lowercased rawCategory exactly', () => {
      const mappings: CategoryMapping[] = [
        { rawValue: 'groceries', categoryId: catId('Groceries') },
      ]
      expect(suggestCategory('SOME STORE', 'Groceries', mappings, KEYWORD_RULES, categoryByName)).toBe(catId('Groceries'))
    })

    it('matches lowercased description exactly', () => {
      const mappings: CategoryMapping[] = [
        { rawValue: 'trader joe\'s #456', categoryId: catId('Groceries') },
      ]
      expect(suggestCategory('TRADER JOE\'S #456', null, mappings, KEYWORD_RULES, categoryByName)).toBe(catId('Groceries'))
    })

    it('prefers rawCategory exact match over description exact match', () => {
      const mappings: CategoryMapping[] = [
        { rawValue: 'groceries', categoryId: catId('Groceries') },
        { rawValue: 'trader joe\'s', categoryId: catId('Dining') },
      ]
      // rawCategory exact wins
      expect(suggestCategory('TRADER JOE\'S', 'Groceries', mappings, KEYWORD_RULES, categoryByName)).toBe(catId('Groceries'))
    })
  })

  describe('2. similarity match', () => {
    it('matches partial descriptions with similarity >= 0.6', () => {
      const mappings: CategoryMapping[] = [
        { rawValue: 'trader joe\'s groceries', categoryId: catId('Groceries') },
      ]
      // "TRADER JOE'S #123" has high overlap with "trader joe's groceries"
      expect(suggestCategory('TRADER JOE\'S #123', null, mappings, KEYWORD_RULES, categoryByName)).toBe(catId('Groceries'))
    })

    it('does NOT match when similarity < threshold', () => {
      const mappings: CategoryMapping[] = [
        { rawValue: 'completely different store name', categoryId: catId('Dining') },
      ]
      expect(suggestCategory('TRADER JOE\'S #123', null, mappings, KEYWORD_RULES, categoryByName)).toBeNull()
    })

    it('picks the best similarity match above threshold', () => {
      const mappings: CategoryMapping[] = [
        { rawValue: 'coffee shop seattle', categoryId: catId('Dining') },
        { rawValue: 'seattle coffee roasters', categoryId: catId('Fast Food') },
      ]
      // "seattle coffee roasters" should match better than "coffee shop seattle"
      const result = suggestCategory('SEATTLE COFFEE ROASTERS', null, mappings, KEYWORD_RULES, categoryByName)
      expect(result).toBe(catId('Fast Food'))
    })
  })

  describe('3. keyword rules', () => {
    describe('fees', () => {
      it('matches "fee" token', () => {
        expect(suggestCategory('MONTHLY MAINTENANCE FEE', null, [], KEYWORD_RULES, categoryByName)).toBe(catId('Fees'))
      })

      it('matches "fees" token', () => {
        expect(suggestCategory('OVERDRAFT FEES $35', null, [], KEYWORD_RULES, categoryByName)).toBe(catId('Fees'))
      })

      it('matches "service charge" compound', () => {
        expect(suggestCategory('WIRE SERVICE CHARGE', null, [], KEYWORD_RULES, categoryByName)).toBe(catId('Fees'))
      })
    })

    describe('transfers', () => {
      it('matches zelle', () => {
        expect(suggestCategory('ZELLE PAYMENT FROM JOHN', null, [], KEYWORD_RULES, categoryByName)).toBe(catId('Transfer'))
      })

      it('matches transfer', () => {
        expect(suggestCategory('RECURRING TRANSFER TO WAY2SAVE', null, [], KEYWORD_RULES, categoryByName)).toBe(catId('Transfer'))
      })

      it('matches xfer', () => {
        expect(suggestCategory('XFER TO SAVINGS', null, [], KEYWORD_RULES, categoryByName)).toBe(catId('Transfer'))
      })
    })

    describe('income', () => {
      it('matches payroll', () => {
        expect(suggestCategory('ACME CORP PAYROLL DEPOSIT', null, [], KEYWORD_RULES, categoryByName)).toBe(catId('Income'))
      })

      it('matches paycheck', () => {
        expect(suggestCategory('BI-WEEKLY PAYCHECK', null, [], KEYWORD_RULES, categoryByName)).toBe(catId('Income'))
      })

      it('matches "direct deposit" compound', () => {
        expect(suggestCategory('ACH DIRECT DEPOSIT 12345', null, [], KEYWORD_RULES, categoryByName)).toBe(catId('Income'))
      })
    })
  })

  describe('4. null / Unknown', () => {
    it('returns null for unrecognized transactions with no matches', () => {
      expect(suggestCategory('RANDOM UNKNOWN STORE XYZ', null, [], KEYWORD_RULES, categoryByName)).toBeNull()
    })

    it('returns null when no keyword rules match', () => {
      expect(suggestCategory('STARBUCKS COFFEE', null, [], KEYWORD_RULES, categoryByName)).toBeNull()
    })
  })

  describe('priority: learned mapping beats keywords', () => {
    it('exact mapping wins over keyword rule', () => {
      const mappings: CategoryMapping[] = [
        { rawValue: 'monthly maintenance fee', categoryId: catId('Utilities') },
      ]
      // Keyword would say Fees, but exact mapping says Utilities
      expect(suggestCategory('MONTHLY MAINTENANCE FEE', null, mappings, KEYWORD_RULES, categoryByName)).toBe(catId('Utilities'))
    })

    it('similarity mapping wins over keyword rule', () => {
      const mappings: CategoryMapping[] = [
        { rawValue: 'monthly fee charge', categoryId: catId('Utilities') },
      ]
      // Keyword would say Fees, but similarity mapping says Utilities
      expect(suggestCategory('MONTHLY FEE CHARGE', null, mappings, KEYWORD_RULES, categoryByName)).toBe(catId('Utilities'))
    })

    it('keyword wins when no mappings exist', () => {
      expect(suggestCategory('OVERDRAFT FEE $35', null, [], KEYWORD_RULES, categoryByName)).toBe(catId('Fees'))
    })
  })

  describe('edge cases', () => {
    it('handles null rawCategory', () => {
      const mappings: CategoryMapping[] = [
        { rawValue: 'starbucks coffee', categoryId: catId('Dining') },
      ]
      expect(suggestCategory('STARBUCKS COFFEE', null, mappings, KEYWORD_RULES, categoryByName)).toBe(catId('Dining'))
    })

    it('handles empty mappings', () => {
      expect(suggestCategory('OVERDRAFT FEE', null, [], KEYWORD_RULES, categoryByName)).toBe(catId('Fees'))
    })

    it('handles empty description gracefully', () => {
      const mappings: CategoryMapping[] = [
        { rawValue: '', categoryId: catId('Other') },
      ]
      expect(suggestCategory('', null, mappings, KEYWORD_RULES, categoryByName)).toBe(catId('Other'))
    })

    it('rawCategory exact match is checked before description exact', () => {
      const mappings: CategoryMapping[] = [
        { rawValue: 'fees', categoryId: catId('Fees') },
        { rawValue: 'bank fee', categoryId: catId('Utilities') },
      ]
      // rawCategory = "fees" → exact match on rawValue "fees" → Fees
      expect(suggestCategory('BANK FEE', 'fees', mappings, KEYWORD_RULES, categoryByName)).toBe(catId('Fees'))
    })
  })
})
