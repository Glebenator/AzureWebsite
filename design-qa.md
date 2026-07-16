# Design QA

- Source visual truth: `artifacts/design-reference-option-1.png`
- Desktop implementation evidence: `artifacts/desktop-1435x1096-final.png`
- Mobile top evidence: `artifacts/mobile-390-top-final.png`
- Mobile footer evidence: `artifacts/mobile-390-footer-final.png`
- Desktop viewport: 1435 × 1096
- Mobile viewport: 390 × 844
- Desktop state: first project expanded; GitHub navigation link focused
- Mobile state: first project expanded; default motion state

## Full-view comparison evidence

The source and desktop implementation were opened together at their native 1435 × 1096 size. The implementation preserves the source's warm ivory canvas, black display type, cobalt focus and action color, thin horizontal rules, oversized two-line name, right-aligned technical motif, three numbered project rows, expanded first-project texture, and split footer with motion control. The implementation deliberately replaces illustrative mock copy with locally verified project descriptions and technology labels.

The final 390px top and footer captures were inspected separately for the responsive adaptation. Content reflows into a single column without hiding project actions, the long surname remains within the viewport, project rows retain their hierarchy, and all visible interactive targets measure 44px high. The dedicated footer capture proves the About copy, closing line, and motion control at the bottom of the page.

## Focused-region comparison evidence

A separate crop was not required. Both full-view desktop images are identical in pixel dimensions and were inspected at original resolution; navigation focus, hero typography, generated image edges, project metadata, icon alignment, row dividers, and footer controls were all legible in the comparison input.

## Required fidelity surfaces

- Fonts and typography: The implementation uses a local Helvetica/Arial grotesk stack and a local system monospace stack, matching the source's display-versus-metadata contrast. Weight, line height, letter spacing, and wrapping preserve the source hierarchy. The mobile display scale was reduced only enough to prevent surname clipping.
- Spacing and layout rhythm: Header, hero, work rows, expanded project strip, and footer align to the same page frame and section rhythm as the source. The desktop footer divider was moved to the center track to match the reference.
- Colors and visual tokens: `#faf8f2`, `#141413`, and `#173be7` reproduce the ivory, ink, and cobalt visual system with strong contrast. No gradients or shadows were introduced.
- Image quality and asset fidelity: Both visible technical motifs are generated raster assets at their consuming dimensions. They have no text, logos, claims, placeholder boxes, custom SVG substitutes, or CSS-drawn replacements. Their backgrounds now merge cleanly with the page canvas.
- Copy and content: Names, summaries, technologies, and destinations are grounded in local repository evidence. The source mock's inaccurate illustrative claims were intentionally not reproduced.
- Icons: All controls use the locally served Phosphor icon font with consistent weight and alignment. No text-glyph or handcrafted SVG icon substitutes are present.
- Interaction and accessibility: Internal navigation, external project actions, project reveal toggles, skip navigation, focus-visible styling, motion preference toggling, semantic headings, ARIA expansion state, and reduced-motion CSS were tested. The stable `Reduce motion` toggle name stays aligned with `aria-pressed`; a separate live status announces the effective state. An OS-level preference disables the local override and is synchronized through a media-query change listener. Browser console warnings/errors: none.
- Responsiveness: Final mobile metrics were `viewportWidth: 390`, `scrollWidth: 390`, and `bodyScrollWidth: 390`. Visible navigation, project toggles, project actions, wordmark, and motion controls are 44px high.

## Comparison history

### Iteration 1

- [P2] The initial 390px render overflowed horizontally by 14px and clipped the surname. Fixed by tightening the small-screen display and project-title scales. Post-fix evidence: `mobile-390x844-v2.png`; final metrics show no overflow.
- [P2] The initial hero raster revealed a darker rectangular background against the canvas. Fixed by aligning the canvas token to the generated asset and removing the multiply blend. Post-fix evidence: `desktop-1435x1096-v2.png`.
- [P2] The initial footer lacked the source's central vertical divider and used a less faithful motion treatment. Fixed with a centered grid divider, a circle-half icon, and Reduce/Enable motion labels. Post-fix evidence: `desktop-1435x1096-final.png`.
- [P2] Project action links and the wordmark did not guarantee comfortable mobile target height. Fixed with a 44px minimum target height. Post-fix browser measurements confirm 44px.

### Final pass

No actionable P0, P1, or P2 differences remain. The verified copy differs intentionally from the generated mock because public accuracy and safety take precedence over illustrative placeholder content.

### Independent review remediation

- [P2] The motion control could offer Enable motion while the OS media query continued to suppress animation. Fixed by making the system preference authoritative, disabling the local override when required, synchronizing live media-query changes, keeping the toggle name stable, and announcing effective state through a separate live status.
- [P2] The featured toggle was named as a details control even though it reveals a visual strip. Fixed by giving the featured control the exact accessible name `Toggle project visual for CvkeHarness`; text-detail toggles retain their existing names.
- [P2] The original full-page mobile evidence did not visibly include the footer in review tooling. Replaced it with explicit 390 × 844 top and footer viewport captures; the footer capture includes the full About copy, closing line, and motion control.

## Findings

No actionable P0, P1, or P2 findings remain.

## Follow-up polish

No blocking follow-up polish. A later content pass can add a real live demo or download action only after a public destination is verified.

final result: passed
