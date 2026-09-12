"""Swap the Contact Form 7 markup for a plain POST form.

CF7 submits over AJAX to /wp-json/contact-form-7/..., which does not exist on a
static host. Left alone the form would look like it worked and drop every
enquiry silently. A normal form POST also works without JavaScript.
"""
import io, re, sys

p = sys.argv[1]
h = io.open(p, encoding="utf-8", errors="replace").read()

m = re.search(r'<form[^>]*wpcf7-form.*?</form>', h, re.S)
if not m:
    print("  no CF7 form found - nothing changed"); sys.exit(1)
old = m.group(0)

# Keep the theme's own classes so the styling carries over unchanged.
new = '''<form action="/contact-send" method="post" class="wpcf7-form" novalidate="novalidate">
<p><span class="wpcf7-form-control-wrap" data-name="your-name">
<input size="40" class="wpcf7-form-control wpcf7-text wpcf7-validates-as-required" autocomplete="name" required="required" placeholder="Name" value="" type="text" name="your-name"></span></p>
<p><span class="wpcf7-form-control-wrap" data-name="your-number">
<input size="40" class="wpcf7-form-control wpcf7-text" autocomplete="tel" placeholder="Mobile Number" value="" type="text" name="your-number"></span></p>
<p><span class="wpcf7-form-control-wrap" data-name="your-email">
<input size="40" class="wpcf7-form-control wpcf7-email wpcf7-validates-as-required" autocomplete="email" required="required" placeholder="Email Address" value="" type="email" name="your-email"></span></p>
<p><span class="wpcf7-form-control-wrap" data-name="your-country">
<input size="40" class="wpcf7-form-control wpcf7-text" placeholder="City &amp; Country" value="" type="text" name="your-country"></span></p>
<p><span class="wpcf7-form-control-wrap" data-name="your-message">
<textarea cols="40" rows="10" class="wpcf7-form-control wpcf7-textarea wpcf7-validates-as-required" required="required" placeholder="Leave us a message" name="your-message"></textarea></span></p>
<p style="position:absolute;left:-9999px" aria-hidden="true">
<label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
<p><input class="wpcf7-form-control wpcf7-submit" type="submit" value="Send">
<input class="wpcf7-form-control wpcf7-reset" type="reset" value="Reset"></p>
</form>'''

io.open(p, "w", encoding="utf-8", newline="\n").write(h.replace(old, new, 1))
print("  form replaced: %d bytes -> %d bytes" % (len(old), len(new)))
print("  fields:", ", ".join(re.findall(r'name="([^"]+)"', new)))
