import { describe, expect, it } from 'vitest';
import type { PageHit } from '../src/pure.js';
import { ARTICLE_RE, countLinks, isThin, looksRight, MIN_CHARS, MIN_LINKS } from '../src/web.js';

function hit(markdown: string, url = 'https://example.com/integrations'): PageHit {
    return { url, markdown };
}

/** Builds markdown of an exact character length containing exactly `linkCount` markdown links. */
function markdownOfLength(totalLength: number, linkCount: number): string {
    const links = Array.from({ length: Math.max(0, linkCount) }, (_, i) => `[l${i}](u)`).join('');
    const padding = 'x'.repeat(Math.max(0, totalLength - links.length));
    return padding + links;
}

function goodPage(keyword: string, url = 'https://example.com/integrations'): PageHit {
    const links = Array.from({ length: MIN_LINKS + 2 }, (_, i) => `[l${i}](u${i})`).join(' ');
    return { url, markdown: `Our ${keyword} list. ${'x'.repeat(MIN_CHARS)} ${links}` };
}

describe('countLinks', () => {
    it('counts markdown link occurrences', () => {
        expect(countLinks('no links here')).toBe(0);
        expect(countLinks('[a](url) and [b](url2)')).toBe(2);
    });
});

describe('isThin', () => {
    it('treats a null hit as thin', () => {
        expect(isThin(null)).toBe(true);
    });

    it('is thin one char under MIN_CHARS even with plenty of links', () => {
        const md = markdownOfLength(MIN_CHARS - 1, MIN_LINKS + 10);
        expect(isThin(hit(md))).toBe(true);
    });

    it('is not thin at exactly MIN_CHARS with enough links', () => {
        const md = markdownOfLength(MIN_CHARS, MIN_LINKS + 10);
        expect(isThin(hit(md))).toBe(false);
    });

    it('is thin one link under MIN_LINKS even with plenty of chars', () => {
        const md = markdownOfLength(MIN_CHARS + 500, MIN_LINKS - 1);
        expect(isThin(hit(md))).toBe(true);
    });

    it('is not thin at exactly MIN_LINKS links with enough chars', () => {
        const md = markdownOfLength(MIN_CHARS + 500, MIN_LINKS);
        expect(isThin(hit(md))).toBe(false);
    });
});

describe('ARTICLE_RE', () => {
    it('matches blog/guide/changelog-shaped paths', () => {
        expect(ARTICLE_RE.test('https://example.com/blog/post-1')).toBe(true);
        expect(ARTICLE_RE.test('https://example.com/guides/setup')).toBe(true);
        expect(ARTICLE_RE.test('https://example.com/changelog/2024')).toBe(true);
    });

    it('does not match an actual integrations listing path', () => {
        expect(ARTICLE_RE.test('https://example.com/integrations')).toBe(false);
        expect(ARTICLE_RE.test('https://example.com/integrations/')).toBe(false);
    });
});

describe('looksRight', () => {
    it('accepts a thick, on-topic, non-article page', () => {
        expect(looksRight(goodPage('integrat'), 'integrat')).toBe(true);
    });

    it('rejects a page that lacks the keyword', () => {
        expect(looksRight(goodPage('integrat'), 'alternativ')).toBe(false);
    });

    it('rejects an article-shaped URL even with the keyword and enough content', () => {
        const page = goodPage('integrat', 'https://example.com/blog/why-integrations-matter');
        expect(looksRight(page, 'integrat')).toBe(false);
    });

    it('rejects a thin page even if the keyword is present', () => {
        expect(looksRight(hit('integrat'), 'integrat')).toBe(false);
    });

    it('rejects a null hit', () => {
        expect(looksRight(null, 'integrat')).toBe(false);
    });
});
