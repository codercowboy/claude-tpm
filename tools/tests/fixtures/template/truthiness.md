<!-- tpm:if v.emptyStr -->
BAD-emptystr
<!-- tpm:endif -->
<!-- tpm:if v.zero -->
BAD-zero
<!-- tpm:endif -->
<!-- tpm:if v.emptyArr -->
BAD-emptyarr
<!-- tpm:endif -->
<!-- tpm:if v.emptyObj -->
BAD-emptyobj
<!-- tpm:endif -->
<!-- tpm:if v.nul -->
BAD-null
<!-- tpm:endif -->
<!-- tpm:if v.str -->
ok-str
<!-- tpm:endif -->
<!-- tpm:if v.one -->
ok-one
<!-- tpm:endif -->
<!-- tpm:if v.arr -->
ok-arr
<!-- tpm:endif -->
<!-- tpm:if v.obj -->
ok-obj
<!-- tpm:endif -->
<!-- tpm:if v.arr[0] -->
ok-index
<!-- tpm:endif -->
<!-- tpm:if !v.zero -->
ok-neg-zero
<!-- tpm:endif -->
<!-- tpm:if !v.str -->
BAD-neg-str
<!-- tpm:endif -->
