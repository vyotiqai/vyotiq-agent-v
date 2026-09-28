/**
 * The public path of a page. A build renders Astro.url.pathname as the output
 * file ("/download.html", "/docs/index.html"); the dev server does not. Both
 * come out as the URL a visitor uses: "/download", "/docs/".
 */
export const pagePath = (pathname: string) => pathname.replace(/index\.html$/, '').replace(/\.html$/, '')

/** A path compared without its trailing slash, so "/docs" and "/docs/" are one page. */
export const samePath = (pathname: string) => pagePath(pathname).replace(/(.)\/$/, '$1')
