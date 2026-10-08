(function () {
  const icons = __REVIEW_ICONS__;
  const icon = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({viewBox:'0 0 24 24',width:'18',height:'18',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key,value);
    for (const [tag, attributes] of icons[name] ?? []) {
      const node = document.createElementNS(svg.namespaceURI, tag);
      for (const [key,value] of Object.entries(attributes)) node.setAttribute(key, value);
      svg.append(node);
    }
    return svg;
  };
  window.ReviewUI = {icon, refresh(root=document) {
    root.querySelectorAll('[data-review-icon]').forEach(node => node.replaceChildren(icon(node.dataset.reviewIcon)));
  }};
  ReviewUI.refresh();
})();
