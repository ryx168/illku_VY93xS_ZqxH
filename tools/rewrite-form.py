"""Swap hons.ca's WPForms markup for plain POST forms the static host can serve.

WPForms submits over AJAX to /wp-json + admin-ajax.php, which do not exist on a
static host - left alone the forms look like they work and silently drop every
enquiry and job application. _worker.js handles the replacements:

  #1291 Contact     -> POST /contact-send  (First/Last name, Email, Category, Phone, Request)
  #1358 Application -> POST /apply-send     (Position, First/Last name, Email, Phone, Resume file)

The application keeps a real <input type=file>; the worker stores the resume in
R2 and emails it to HR as an attachment. Field names match the worker's readers.
Idempotent: a form already pointing at our endpoints is left untouched.
"""
import io, os, re, sys

ROOT = sys.argv[1]

REQ = '<span class="wpforms-required-label" aria-hidden="true">*</span>'

CONTACT = '''<form action="/contact-send" method="post" class="wpforms-form" novalidate="novalidate">
<div class="wpforms-field wpforms-field-name"><label class="wpforms-field-label">First Name %(req)s</label><input type="text" class="wpforms-field-large wpforms-field-required" name="first-name" placeholder="First Name" autocomplete="given-name" required="required"></div>
<div class="wpforms-field wpforms-field-name"><label class="wpforms-field-label">Last Name %(req)s</label><input type="text" class="wpforms-field-large wpforms-field-required" name="last-name" placeholder="Last Name" autocomplete="family-name" required="required"></div>
<div class="wpforms-field wpforms-field-email"><label class="wpforms-field-label">Email %(req)s</label><input type="email" class="wpforms-field-large wpforms-field-required" name="email" placeholder="Email Address" autocomplete="email" required="required"></div>
<div class="wpforms-field wpforms-field-checkbox"><label class="wpforms-field-label">How can we help?</label><ul class="wpforms-field-required">
<li><label><input type="checkbox" name="category" value="New Customers' Needs"> New Customers' Needs</label></li>
<li><label><input type="checkbox" name="category" value="Old Customers' Feedback"> Old Customers' Feedback</label></li>
<li><label><input type="checkbox" name="category" value="Other Services"> Other Services</label></li>
</ul></div>
<div class="wpforms-field wpforms-field-phone"><label class="wpforms-field-label">Phone %(req)s</label><input type="tel" class="wpforms-field-large wpforms-field-required" name="phone" placeholder="Phone" autocomplete="tel" required="required"></div>
<div class="wpforms-field wpforms-field-textarea"><label class="wpforms-field-label">Request</label><textarea class="wpforms-field-large" name="request" rows="5" placeholder="How can we help you?"></textarea></div>
<div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<div class="wpforms-submit-container"><button type="submit" class="wpforms-submit">Submit</button></div>
</form>''' % {"req": REQ}

APPLICATION = '''<form action="/apply-send" method="post" enctype="multipart/form-data" class="wpforms-form" novalidate="novalidate">
<div class="wpforms-field wpforms-field-checkbox"><label class="wpforms-field-label">Position Applied For %(req)s</label><ul class="wpforms-field-required">
<li><label><input type="checkbox" name="position" value="Packaging Crew"> Packaging Crew</label></li>
<li><label><input type="checkbox" name="position" value="Machine Operator"> Machine Operator</label></li>
<li><label><input type="checkbox" name="position" value="Business Development"> Business Development</label></li>
<li><label><input type="checkbox" name="position" value="Sanitation Crew"> Sanitation Crew</label></li>
</ul></div>
<div class="wpforms-field wpforms-field-name"><label class="wpforms-field-label">First Name %(req)s</label><input type="text" class="wpforms-field-large wpforms-field-required" name="first-name" placeholder="First Name" autocomplete="given-name" required="required"></div>
<div class="wpforms-field wpforms-field-name"><label class="wpforms-field-label">Last Name %(req)s</label><input type="text" class="wpforms-field-large wpforms-field-required" name="last-name" placeholder="Last Name" autocomplete="family-name" required="required"></div>
<div class="wpforms-field wpforms-field-email"><label class="wpforms-field-label">Email %(req)s</label><input type="email" class="wpforms-field-large wpforms-field-required" name="email" placeholder="Email Address" autocomplete="email" required="required"></div>
<div class="wpforms-field wpforms-field-phone"><label class="wpforms-field-label">Phone %(req)s</label><input type="tel" class="wpforms-field-large wpforms-field-required" name="phone" placeholder="Phone" autocomplete="tel" required="required"></div>
<div class="wpforms-field wpforms-field-file-upload"><label class="wpforms-field-label">Upload your resume %(req)s</label><input type="file" class="wpforms-field-large wpforms-field-required" name="resume" accept=".pdf,.doc,.docx,.rtf,.odt,.txt" required="required"><div class="wpforms-field-description">PDF, Word, RTF or text, up to 8&nbsp;MB.</div></div>
<div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<div class="wpforms-submit-container"><button type="submit" class="wpforms-submit">Apply</button></div>
</form>''' % {"req": REQ}

# Match one WPForms <form ...> element (non-greedy), capturing data-formid whether
# it appears before or after the wpforms-form class.
FORM_RE = re.compile(r'<form[^>]*data-formid="(\d+)"[^>]*wpforms-form[^>]*>.*?</form>'
                     r'|<form[^>]*wpforms-form[^>]*data-formid="(\d+)"[^>]*>.*?</form>', re.S)

BY_ID = {"1291": CONTACT, "1358": APPLICATION}

changed = 0
scanned = 0
for dirpath, _dirs, files in os.walk(ROOT):
    for name in files:
        if not name.endswith(".html"):
            continue
        p = os.path.join(dirpath, name)
        h = io.open(p, encoding="utf-8", errors="replace").read()
        if "wpforms-form" not in h:
            continue
        scanned += 1

        def repl(m):
            global changed
            fid = m.group(1) or m.group(2)
            new = BY_ID.get(fid)
            if not new:
                print("  WPForms #%s in %s has no rewrite rule - left as-is" % (fid, os.path.relpath(p, ROOT)))
                return m.group(0)
            if ('action="/contact-send"' in m.group(0)) or ('action="/apply-send"' in m.group(0)):
                return m.group(0)  # already rewritten
            changed += 1
            print("  rewrote WPForms #%s in %s" % (fid, os.path.relpath(p, ROOT)))
            return new

        h2 = FORM_RE.sub(repl, h)
        if h2 != h:
            io.open(p, "w", encoding="utf-8", newline="\n").write(h2)

print("  form rewrite: %d file(s) with WPForms scanned, %d form(s) rewritten" % (scanned, changed))
