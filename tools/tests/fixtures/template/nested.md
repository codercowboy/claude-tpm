top
<!-- tpm:if a.on -->
  a-on
  <!-- tpm:if b.on -->
  b-on-under-a-on
    <!-- tpm:if !c.on -->
    c-off-negated-deep
    <!-- tpm:endif -->
  <!-- tpm:endif -->
<!-- tpm:endif -->
<!-- tpm:if a.off -->
a-off-parent
<!-- tpm:if b.on -->
b-on-under-a-off-MUST-DROP
<!-- tpm:endif -->
<!-- tpm:endif -->
<!-- tpm:if b.on -->
sibling-b-on
<!-- tpm:endif -->
bottom
