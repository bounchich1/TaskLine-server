import { describe, expect, it } from 'vitest';

import { commonTerms, pluralTickets } from '../src/modules/incidents/terms.js';

describe('terms', () => {
    it('keeps words and places shared by a third of the tickets', () => {
        const { terms, localities } = commonTerms([
            'Нет интернета на ул. Ленина с 14:00',
            'ул. Ленина д. 5 нет интернета весь дом',
            'Интернет пропал, ул. Ленина',
            'Здравствуйте, не работает телевидение',
        ]);

        expect(localities).toEqual(['ул. Ленина']);
        expect(terms).toEqual(expect.arrayContaining(['ул. Ленина', 'интернета']));
        expect(terms).not.toContain('здравствуйте');
    });

    it('declines the ticket count', () => {
        expect([1, 3, 5, 11, 22, 37].map(pluralTickets)).toEqual([
            '1 обращение',
            '3 обращения',
            '5 обращений',
            '11 обращений',
            '22 обращения',
            '37 обращений',
        ]);
    });
});
