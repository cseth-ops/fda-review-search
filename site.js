(function(){
var d=document.documentElement,t=null;try{t=localStorage.getItem('theme')}catch(e){}
if(t)d.setAttribute('data-theme',t);
document.addEventListener('DOMContentLoaded',function(){
 var b=document.getElementById('themetoggle');if(b)b.addEventListener('click',function(){
  var dark=d.getAttribute('data-theme')==='dark'||(!d.getAttribute('data-theme')&&matchMedia('(prefers-color-scheme: dark)').matches);
  var n=dark?'light':'dark';d.setAttribute('data-theme',n);try{localStorage.setItem('theme',n)}catch(e){}});
 var nv=document.querySelector('nav.main'),tg=document.getElementById('navtoggle');
 if(tg)tg.addEventListener('click',function(){var o=nv.classList.toggle('open');tg.setAttribute('aria-expanded',o)});
 document.querySelectorAll('.menu>button').forEach(function(m){m.addEventListener('click',function(e){e.stopPropagation();
  var o=m.parentNode.classList.toggle('open');m.setAttribute('aria-expanded',o)})});
 document.addEventListener('click',function(){document.querySelectorAll('.menu.open').forEach(function(m){m.classList.remove('open')})});
});})();
