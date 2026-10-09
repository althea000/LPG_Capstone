# Codex Task: Add GasTrack Terms of Service and Privacy Policy Pages

Implement dedicated Terms of Service and Privacy Policy pages linked from `Login.jsx`.

## Source content files
Use these extracted text files as the authoritative source content:
- `Terms of Service.txt`
- `Privacy Policy.txt`

These files were extracted from the supplied PDFs. Preserve the text exactly, including wording, headings, section order, contact details, and the `Last updated October 08, 2026` date. Do not summarize, rewrite, correct, or invent legal clauses. If the project repository does not contain these files, ask me to add them or copy their content into maintainable local content files before proceeding; do not substitute generic legal text.

## Before coding
1. Inspect `Login.jsx`, the existing React router, styles, shared components, and current login/registration flow.
2. Check how the app handles page navigation and whether reusable modal/page components already exist.
3. Make the smallest safe changes consistent with the current architecture.

## Requirements
1. Add visible `Terms of Service` and `Privacy Policy` links to the login page, styled consistently with GasTrack.
2. Prefer separate, responsive routes/pages if the project already uses a router. Otherwise use the simplest existing pattern (for example, a local modal or dedicated page components) without adding unnecessary dependencies.
3. Display the complete content from the matching text file. Preserve all titles, headings, numbered sections, lists, paragraphs, dates, phone numbers, email addresses, and URLs. Do not render PDF screenshots instead of readable text.
4. Ensure long text is readable, scrollable, and responsive on desktop and mobile. Use semantic headings and accessible links/buttons. Provide a clear way to return to Login or close the modal.
5. Do not add a mandatory acceptance checkbox or change authentication requirements unless explicitly requested.
6. Do not change login authentication, API calls, validation, password visibility, error handling, registration behavior, account creation fields, sessions, or backend endpoints.
7. Do not change other GasTrack modules: Dashboard, POS Terminal, Inventory, Products, Sales, Restocking, Order and Delivery, Suppliers, Report and Compliance, Data, Users, or Settings.
8. Avoid global CSS changes. Keep styling local and preserve shared component behavior.
9. Do not make the source text files publicly downloadable or add an upload endpoint solely to display legal content.

## Content completeness checks
- The Terms of Service source contains 24 numbered sections, from `1. OUR SERVICES` through `24. CONTACT US`.
- The Privacy Policy source contains 12 numbered sections, from `1. WHAT INFORMATION DO WE COLLECT?` through `12. HOW CAN YOU REVIEW, UPDATE, OR DELETE THE DATA WE COLLECT FROM YOU?`.
- Both documents show `Last updated October 08, 2026`.
Verify that all sections are rendered in the correct order and that no text has been omitted.

## Testing
- Test both links and confirm each opens the correct document.
- Confirm all sections are present and the full content can be read.
- Test closing/back navigation and direct route refresh if routes are used.
- Check responsive layout, keyboard access, and console/build errors.
- Confirm existing login and registration flows are unchanged.
- Run relevant existing tests and report actual results; do not claim tests passed unless executed.

## Final report
Summarize the implementation, list files changed, explain where the content is stored, and report tests and any remaining issues.
