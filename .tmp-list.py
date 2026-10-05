import re
html = open('.tmp-api.html', encoding='utf-8').read()
def sec(name, nxt):
    i = html.find(f'name="{name}"')
    j = html.find(f'name="{nxt}"')
    s = html[i:j] if j > i else html[i:i+5000]
    t = re.sub(r'<[^>]+>', ' ', s)
    return re.sub(r'\s+', ' ', t)
print("=== InputRichBlockList ===")
print(sec("inputrichblocklist", "inputrichblocklistitem")[:1200])
print()
print("=== InputRichBlockListItem ===")
print(sec("inputrichblocklistitem", "inputrichblockmap")[:1500])
