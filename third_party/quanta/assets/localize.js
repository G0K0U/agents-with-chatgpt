(() => {
  const config = /*CONFIG*/;
  const keys = Object.keys(config.strings).filter(k => k.length > 1).sort((a,b)=>b.length-a.length);
  function translate(text) {
    if (Object.hasOwn(config.strings, text)) return config.strings[text];
    for (const [pattern, replacement] of config.patterns) {
      text = text.replace(new RegExp(pattern, 'g'), replacement.replace(/\\(\d)/g, '$$$1'));
    }
    for (const key of keys) text = text.split(key).join(config.strings[key]);
    return text.replaceAll('；','; ').replaceAll('（',' (').replaceAll('）',')');
  }
  function update() {
    observer.disconnect();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('script,style,textarea,[data-no-translate]')) continue;
      const next = translate(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    }
    for (const element of document.querySelectorAll('[placeholder],[aria-label],[title]')) {
      for (const name of ['placeholder','aria-label','title']) {
        if (element.hasAttribute(name)) element.setAttribute(name, translate(element.getAttribute(name)));
      }
    }
    document.title = translate(document.title);
    document.documentElement.lang = 'en';
    observer.observe(document.body, {subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['placeholder','aria-label','title']});
  }
  const observer = new MutationObserver(update);
  update();
})();
