//---------------------------------------------------------------------
// Managed Object Dashboard URL resolver
//---------------------------------------------------------------------
// Copyright (C) 2007-2026 The NOC Project
// See LICENSE for details
//---------------------------------------------------------------------
console.debug("Defining NOC.core.ManagedObjectDashboard");

Ext.define("NOC.core.ManagedObjectDashboard", {
  singleton: true,
  nativeFeature: "nativedashboard",

  isNativeEnabled: function(){
    return (NOC.settings.features || []).includes(this.nativeFeature);
  },

  getUrl: function(objectId){
    if(this.isNativeEnabled()){
      return "/ui/monitoring-dashboard.html?dashboard=mo&id=" + objectId;
    }
    return "/ui/grafana/dashboard/script/noc.js?dashboard=mo&id=" + objectId;
  },

  open: function(objectId){
    window.open(this.getUrl(objectId));
  },
});
