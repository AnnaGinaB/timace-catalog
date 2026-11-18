/* Timace Know-How Catalog: vrstva pro ukládání do Supabase.
   Stránka byla napsaná pro Claude artifacty (window.claude.use('db' | 'user' | 'downloads')).
   Tahle vrstva tentýž rozhraní nabízí nad Supabase, takže se zbytek webu nemusel měnit.
   Data jsou v jedné tabulce public.docs (collection, id, data jsonb), práva řeší Row Level Security v setup.sql. */
(function(){
  'use strict';
  var cfg = window.TIMACE_CONFIG || {};
  var configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && cfg.SUPABASE_URL.indexOf('TVUJ-PROJEKT') === -1 && window.supabase);
  var sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
  var session = null, isAdmin = false;

  function denied(err){
    var m = ((err && (err.message || '')) + '').toLowerCase();
    return err && (err.code === '42501' || err.code === 'PGRST301' || m.indexOf('row-level security') >= 0 || m.indexOf('permission denied') >= 0 || err.status === 401 || err.status === 403);
  }
  function wrap(err){
    var e = new Error((err && err.message) || 'db error');
    e.code = denied(err) ? 'invalid_argument' : ((err && err.code) || 'unknown');
    return e;
  }
  function mkDoc(row){
    return { id: row.id, exists: true, metadata: { hasPendingWrites: false }, data: function(){ return row.data; } };
  }

  /* ---------- auth ---------- */
  var Auth = {
    configured: configured,
    sb: sb,
    async init(){
      if(!sb) return null;
      var r = await sb.auth.getSession();
      session = r && r.data && r.data.session || null;
      sb.auth.onAuthStateChange(function(ev, s){ session = s; });
      if(session) await refreshAdmin();
      return session;
    },
    user(){ return session && session.user || null; },
    async signIn(email, password){
      var r = await sb.auth.signInWithPassword({ email: email, password: password });
      if(r.error) throw r.error;
      session = r.data.session; await refreshAdmin(); return session;
    },
    async signUp(email, password){
      var r = await sb.auth.signUp({ email: email, password: password });
      if(r.error) throw r.error;
      session = r.data.session;
      if(session) await refreshAdmin();
      return { session: session, needsConfirm: !session };
    },
    async reset(email){
      var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if(r.error) throw r.error;
    },
    async signOut(){ await sb.auth.signOut(); session = null; isAdmin = false; }
  };
  async function refreshAdmin(){
    isAdmin = false;
    try{
      var uid = session && session.user && session.user.id; if(!uid) return;
      var r = await sb.from('admins').select('user_id').eq('user_id', uid).maybeSingle();
      isAdmin = !!(r && r.data);
    }catch(e){}
  }
  window.TimaceAuth = Auth;

  /* ---------- realtime: jeden kanál pro celou tabulku ---------- */
  var listeners = {}, channel = null;
  function ensureChannel(){
    if(channel || !sb) return;
    channel = sb.channel('docs-all')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, function(p){
        var row = (p.eventType === 'DELETE') ? p.old : p.new; if(!row || !listeners[row.collection]) return;
        var type = p.eventType === 'DELETE' ? 'removed' : (p.eventType === 'INSERT' ? 'added' : 'modified');
        var doc = p.eventType === 'DELETE' ? { id: row.id, exists: false, metadata: {}, data: function(){ return {}; } } : mkDoc(row);
        listeners[row.collection].forEach(function(cb){ cb({ docChanges: function(){ return [{ type: type, doc: doc }]; } }); });
      })
      .subscribe();
  }

  /* ---------- db ---------- */
  var db = {
    collection: function(col){
      return {
        async get(){
          var r = await sb.from('docs').select('id,data').eq('collection', col);
          if(r.error) throw wrap(r.error);
          return { docs: (r.data || []).map(mkDoc), empty: !(r.data && r.data.length) };
        },
        onSnapshot: function(cb, errCb){
          var self = this, dead = false;
          (listeners[col] = listeners[col] || []).push(cb);
          ensureChannel();
          this.get().then(function(snap){
            if(dead) return;
            cb({ docChanges: function(){ return snap.docs.map(function(d){ return { type: 'added', doc: d }; }); } });
          }).catch(function(e){ if(errCb) errCb(e); });
          return function(){ dead = true; listeners[col] = (listeners[col] || []).filter(function(f){ return f !== cb; }); };
        }
      };
    },
    doc: function(path){
      var i = path.indexOf('/'), col = path.slice(0, i), id = path.slice(i + 1);
      return {
        async get(){
          var r = await sb.from('docs').select('id,data').eq('collection', col).eq('id', id).maybeSingle();
          if(r.error) throw wrap(r.error);
          if(!r.data) return { id: id, exists: false, data: function(){ return undefined; } };
          return mkDoc(r.data);
        },
        async set(data){
          var r = await sb.from('docs').upsert({ collection: col, id: id, data: data }, { onConflict: 'collection,id' });
          if(r.error) throw wrap(r.error);
        },
        async delete(){
          var r = await sb.from('docs').delete().eq('collection', col).eq('id', id);
          if(r.error) throw wrap(r.error);
        }
      };
    }
  };

  var userNs = {
    id: async function(){ return session && session.user && session.user.id || null; },
    isOwner: async function(){ return isAdmin; },
    canEdit: async function(){ return isAdmin; },
    can: function(){ return true; }
  };
  var downloads = {
    save: async function(o){
      var blob = new Blob([o.data], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.filename;
      document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }
  };

  /* Rozhraní, které stránka očekává. 'sample' (AI Průvodce) tu záměrně není, Průvodce je ve webu vypnutý. */
  window.claude = {
    use: async function(name){
      if(!sb || !session) return null;
      if(name === 'db') return db;
      if(name === 'user') return userNs;
      if(name === 'downloads') return downloads;
      return null;
    }
  };
})();
