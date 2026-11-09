{
  "targets": [{
    "target_name": "kq_win32",
    "sources": ["kq-win32.c"],
    "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE"],
    "conditions": [["OS=='win'", {
      "libraries": ["shell32.lib", "advapi32.lib", "ole32.lib", "shlwapi.lib"]
    }]]
  }]
}
