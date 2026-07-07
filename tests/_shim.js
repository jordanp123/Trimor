// Test shim: JavaScriptCore (osascript) has no `self`. Point it at the global
// so market-data.js (`self.SWR_DATA = ...`) and the SWR modules load unchanged.
var self = this;
