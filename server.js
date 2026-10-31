import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = "https://v3.football.api-sports.io";
const ROOT = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "500kb" }));
// WinScope arayüzü bu dosyaya gömülüdür; dağıtım için public/index.html gerekmez.
const EMBEDDED_INDEX_HTML = Buffer.from("PCFkb2N0eXBlIGh0bWw+PGh0bWwgbGFuZz0idHIiPjxoZWFkPjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij48bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLGluaXRpYWwtc2NhbGU9MSI+PHRpdGxlPldpblNjb3BlIExpdmU8L3RpdGxlPjxzdHlsZT4KOnJvb3R7LS1iZzojMDQxOTFlOy0tcDojMDgyNzJkOy0tcDI6IzBjMzQzYjstLWxpbmU6IzE1NTA1YTstLXQ6I2YxZmJmYzstLW06IzliYjliZjstLXBpbms6I2ZmMmY2MzstLWdyZWVuOiM0MmU2YTA7LS1hbWJlcjojZmZkMDRhOy0tZ3JheTojN2Y5ZGEzfSp7Ym94LXNpemluZzpib3JkZXItYm94fWJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTU1ZGVnLCMwMzE0MTksIzA3MzAzOCA2NSUsIzA0MTkxZSk7Y29sb3I6dmFyKC0tdCk7Zm9udDoxNHB4IHN5c3RlbS11aSxzYW5zLXNlcmlmfWhlYWRlcntwYWRkaW5nOjE2cHg7bWF4LXdpZHRoOjEwNTBweDttYXJnaW46YXV0bztkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tbGluZSl9LmxvZ297Zm9udC13ZWlnaHQ6OTUwO2xldHRlci1zcGFjaW5nOi4wOGVtO2ZvbnQtc2l6ZToyNXB4fS5sb2dvIHNwYW57Zm9udC1zaXplOjEzcHg7Y29sb3I6dmFyKC0tcGluayk7bWFyZ2luLWxlZnQ6NHB4O2ZvbnQtd2VpZ2h0OjcwMH0uc21hbGwsLnN1Yntjb2xvcjp2YXIoLS1tKTtmb250LXNpemU6MTJweDtsaW5lLWhlaWdodDoxLjQ1fW1haW57bWF4LXdpZHRoOjEwNTBweDttYXJnaW46YXV0bztwYWRkaW5nOjEycHh9LnRvb2xiYXIsLmFjdGlvbnN7ZGlzcGxheTpmbGV4O2dhcDo4cHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZsZXgtd3JhcDp3cmFwO21hcmdpbjoxMHB4IDB9YnV0dG9uLHNlbGVjdCxpbnB1dHtmb250OmluaGVyaXQ7Y29sb3I6dmFyKC0tdCk7YmFja2dyb3VuZDp2YXIoLS1wMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjExcHg7cGFkZGluZzoxMHB4IDEycHh9YnV0dG9ue2N1cnNvcjpwb2ludGVyfS5wcmltYXJ5LC5hY3RpdmV7YmFja2dyb3VuZDp2YXIoLS1waW5rKTtib3JkZXItY29sb3I6dmFyKC0tcGluayk7Zm9udC13ZWlnaHQ6ODAwfS5wYW5lbCwuY2FyZHtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTZweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxNDVkZWcsdmFyKC0tcCksIzA2MjEyNik7cGFkZGluZzoxM3B4O21hcmdpbjoxMnB4IDB9LmhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2NvbG9yOnZhcigtLW0pO2ZvbnQtc2l6ZToxMnB4fS50ZWFtc3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciBhdXRvIDFmcjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDttYXJnaW46MTdweCAwfS50ZWFte2ZvbnQtd2VpZ2h0Ojg1MDtmb250LXNpemU6MTdweDtvdmVyZmxvdy13cmFwOmFueXdoZXJlfS50ZWFtOmxhc3QtY2hpbGR7dGV4dC1hbGlnbjpyaWdodH0uc2NvcmV7Zm9udC13ZWlnaHQ6OTUwO2ZvbnQtc2l6ZToyNnB4O3doaXRlLXNwYWNlOm5vd3JhcH0ubWV0YXt0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjp2YXIoLS1tKTtmb250LXNpemU6MTFweH0udGFic3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7Z2FwOjRweDtiYWNrZ3JvdW5kOiMwNjIxMjY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzozcHg7bWFyZ2luOjEycHggMH0udGFicyBidXR0b257Ym9yZGVyOjA7YmFja2dyb3VuZDp0cmFuc3BhcmVudH0udGFicyBidXR0b24uYWN0aXZle2JhY2tncm91bmQ6dmFyKC0tcGluayl9LmdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyO2dhcDoxMHB4fS50YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1zcGFjaW5nOjAgNXB4fS50YWJsZSB0ZHtiYWNrZ3JvdW5kOiMwNjI0MmE7cGFkZGluZzoxMHB4O2JvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpfS50YWJsZSB0ZDpmaXJzdC1jaGlsZHtib3JkZXItbGVmdDoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo5cHggMCAwIDlweDtjb2xvcjp2YXIoLS1tKX0udGFibGUgdGQ6bGFzdC1jaGlsZHtib3JkZXItcmlnaHQ6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MCA5cHggOXB4IDA7Zm9udC13ZWlnaHQ6ODAwfS5ncm91cHtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTFweDtwYWRkaW5nOjhweH0uZ3R7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6ODUwO21hcmdpbjo0cHggM3B4IDhweH0uYmFye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6NzVweCAxZnIgNDBweDtnYXA6N3B4O2FsaWduLWl0ZW1zOmNlbnRlcjtmb250LXNpemU6MTJweDtwYWRkaW5nOjVweCAwfS50cmFja3toZWlnaHQ6MTFweDtib3JkZXItcmFkaXVzOjIwcHg7YmFja2dyb3VuZDojMTkzZDQ0O292ZXJmbG93OmhpZGRlbn0uZmlsbHtoZWlnaHQ6MTAwJTtiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTtib3JkZXItcmFkaXVzOjIwcHh9LmZpbGwuYW1iZXJ7YmFja2dyb3VuZDp2YXIoLS1hbWJlcil9LmZpbGwuZ3JheXtiYWNrZ3JvdW5kOnZhcigtLWdyYXkpfS5vZGRze2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSk7Z2FwOjdweH0ub2Rke2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGEzMDM3O2JvcmRlci1yYWRpdXM6MTFweDtwYWRkaW5nOjlweDt0ZXh0LWFsaWduOmNlbnRlcjtvdmVyZmxvdy13cmFwOmFueXdoZXJlfS5vZGQgbGFiZWx7ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tKTtmb250LXNpemU6MTFweH0ub2RkIHN0cm9uZ3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxOHB4fS5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH0uZW1wdHl7cGFkZGluZzoxOHB4O3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLW0pfS5lcnJ7Y29sb3I6I2ZmOWJhYX0uc3RhdHRlYW17cGFkZGluZzoxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMHB4O21hcmdpbjo4cHggMH0uc3RhdGxpbmV7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6NXB4IDA7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgIzEyM2E0MX1AbWVkaWEobWF4LXdpZHRoOjY1MHB4KXsuZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5vZGRze2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKX0udGVhbXtmb250LXNpemU6MTRweH0uc2NvcmV7Zm9udC1zaXplOjIzcHh9fQojbWF0Y2hTZWFyY2h7ZmxleDowIDEgMjIwcHghaW1wb3J0YW50O21pbi13aWR0aDoxMjBweCFpbXBvcnRhbnQ7bWF4LXdpZHRoOjI2MHB4fSNzZWFyY2hNYXRjaCwjY2xlYXJNYXRjaFNlYXJjaHtwYWRkaW5nOjhweCAxMHB4O2ZvbnQtc2l6ZToxMnB4fUBtZWRpYShtYXgtd2lkdGg6NjUwcHgpeyNtYXRjaFNlYXJjaFBhbmVsIC50b29sYmFye2dhcDo2cHh9I21hdGNoU2VhcmNoe21heC13aWR0aDpub25lO2ZsZXg6MSAxIDE1MHB4IWltcG9ydGFudH19Ci5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH0uYXJjaGl2ZS1saXN0e2Rpc3BsYXk6Z3JpZDtnYXA6OXB4fS5hcmNoaXZlLWl0ZW17Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4O2JhY2tncm91bmQ6IzA2MjQyYX0uYXJjaGl2ZS1pdGVtIC50aXRsZXtmb250LXdlaWdodDo4NTA7bWFyZ2luLWJvdHRvbTo3cHh9LmFyY2hpdmUtaXRlbSAucm93bGluZXtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjhweDtwYWRkaW5nOjRweCAwfS5hcmNoaXZlLWl0ZW0gLnJvd2xpbmUgc3Bhbntjb2xvcjp2YXIoLS1tKX0uYXJjaGl2ZS1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OHB4O21hcmdpbi10b3A6OXB4O2ZsZXgtd3JhcDp3cmFwfS5hcmNoaXZlLWFjdGlvbnMgYnV0dG9ue3BhZGRpbmc6N3B4IDEwcHh9PC9zdHlsZT48L2hlYWQ+PGJvZHk+PGhlYWRlcj48ZGl2PjxkaXYgY2xhc3M9ImxvZ28iPldJTlNDT1BFIDxzcGFuPkxJVkU8L3NwYW4+PC9kaXY+PGRpdiBjbGFzcz0ic3ViIj5DYW5sxLEgZnV0Ym9sIGFuYWxpeiB2ZSBhbGFybSBzaXN0ZW1pPC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0ic21hbGwiIGlkPSJjb25uIj5CQcSeTEFOSVlPUjwvZGl2PjwvaGVhZGVyPjxtYWluPjxkaXYgY2xhc3M9InRvb2xiYXIiPjxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJyZWZyZXNoIj7ihrsgQ2FubMSxIG1hw6dsYXI8L2J1dHRvbj48aW5wdXQgaWQ9ImRhdGUiIHR5cGU9ImRhdGUiPjxidXR0b24gaWQ9ImJ1bGxldGluIj5Cw7xsdGVuPC9idXR0b24+PGJ1dHRvbiBpZD0ic2hvd0FuYWx5c2VzIj5Hw7xuw7xuIEFuYWxpemxlcmk8L2J1dHRvbj48YnV0dG9uIGlkPSJzaG93Q291cG9ucyI+R8O8bsO8biBLdXBvbmxhcsSxPC9idXR0b24+PHNlbGVjdCBpZD0iZmlsdGVyIj48b3B0aW9uIHZhbHVlPSJhbGwiPlTDvG0gbWHDp2xhcjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9ImxpdmUiPkNhbmzEsTwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PjxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9Im1hdGNoU2VhcmNoUGFuZWwiPjxoMyBzdHlsZT0ibWFyZ2luOjJweCAwIDhweCI+8J+UjiAx4oCZZSAxIE1Bw4cgQVJBPC9oMz48ZGl2IGNsYXNzPSJ0b29sYmFyIiBzdHlsZT0ibWFyZ2luOjAiPjxpbnB1dCBpZD0ibWF0Y2hTZWFyY2giIHR5cGU9InNlYXJjaCIgcGxhY2Vob2xkZXI9IlRha8SxbSBhZMSxOiBGZW5lcmJhaMOnZSwgQmFyY2Vsb25h4oCmIiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoxODBweCI+PGJ1dHRvbiBpZD0ic2VhcmNoTWF0Y2giIGNsYXNzPSJwcmltYXJ5Ij5NYcOnIEFyYTwvYnV0dG9uPjxidXR0b24gaWQ9ImNsZWFyTWF0Y2hTZWFyY2giPlRlbWl6bGU8L2J1dHRvbj48L2Rpdj48ZGl2IGlkPSJtYXRjaFNlYXJjaFJlc3VsdCIgY2xhc3M9InNtYWxsIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPkFyYW1hayBpw6dpbiB0YWvEsW0gYWTEsW7EsSB5YXouPC9kaXY+PC9zZWN0aW9uPjxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9ImNvdXBvblBhbmVsIj48aDMgc3R5bGU9Im1hcmdpbjoycHggMCAxMHB4Ij7wn46vIFdJTlNDT1BFIEtVUE9OTEFSSTwvaDM+PGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2dhcDo4cHg7ZmxleC13cmFwOndyYXAiPjxidXR0b24gaWQ9Im1ha2VDb3Vwb24iIGNsYXNzPSJwcmltYXJ5Ij7imr0gTWHDpyDDlm7DvCBLdXBvbnUgKEVuIGF6IDIgbWHDpyk8L2J1dHRvbj48YnV0dG9uIGlkPSJtYWtlU3VycHJpc2VDb3Vwb24iIHN0eWxlPSJiYWNrZ3JvdW5kOiNmZmNjNjY7Y29sb3I6IzIwMTcwMDtmb250LXdlaWdodDo5MDA7Ym9yZGVyOm5vbmUiPvCfjrIgTWHDpyDDlm7DvCBTw7xycHJpeiAoMTAgbWHDpyk8L2J1dHRvbj48YnV0dG9uIGlkPSJtYWtlTGl2ZUJlc3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiM0MmU2YTA7Y29sb3I6IzA0MTkxZTtmb250LXdlaWdodDo5MDA7Ym9yZGVyOm5vbmUiPuKaoSBDYW5sxLEgRW4gR8O8dmVuaWxpciBUZWsgVGVyY2loPC9idXR0b24+PC9kaXY+PGRpdiBpZD0iY291cG9uUmVzdWx0IiBjbGFzcz0ic21hbGwiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPjwvZGl2Pjwvc2VjdGlvbj48c2VjdGlvbiBjbGFzcz0icGFuZWwgaGlkZGVuIiBpZD0iYW5hbHlzZXNBcmNoaXZlIj48ZGl2IGNsYXNzPSJoZWFkIj48aDM+8J+TiyBHw7xuw7xuIEFuYWxpemxlcmk8L2gzPjxidXR0b24gb25jbGljaz0iY2xvc2VBcmNoaXZlcygpIj5LYXBhdDwvYnV0dG9uPjwvZGl2PjxkaXYgaWQ9ImFuYWx5c2VzQXJjaGl2ZUxpc3QiIGNsYXNzPSJhcmNoaXZlLWxpc3QiPlnDvGtsZW5peW9y4oCmPC9kaXY+PC9zZWN0aW9uPjxzZWN0aW9uIGNsYXNzPSJwYW5lbCBoaWRkZW4iIGlkPSJjb3Vwb25zQXJjaGl2ZSI+PGRpdiBjbGFzcz0iaGVhZCI+PGgzPvCfjp/vuI8gR8O8bsO8biBLdXBvbmxhcsSxPC9oMz48YnV0dG9uIG9uY2xpY2s9ImNsb3NlQXJjaGl2ZXMoKSI+S2FwYXQ8L2J1dHRvbj48L2Rpdj48ZGl2IGlkPSJjb3Vwb25zQXJjaGl2ZUxpc3QiIGNsYXNzPSJhcmNoaXZlLWxpc3QiPlnDvGtsZW5peW9y4oCmPC9kaXY+PC9zZWN0aW9uPjxkaXYgaWQ9Im1zZyIgY2xhc3M9InNtYWxsIj48L2Rpdj48c2VjdGlvbiBpZD0ibWF0Y2hlcyI+PGRpdiBjbGFzcz0iZW1wdHkiPk1hw6dsYXIgecO8a2xlbml5b3LigKY8L2Rpdj48L3NlY3Rpb24+PC9tYWluPjxzY3JpcHQ+CmNvbnN0ICQ9eD0+ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoeCk7bGV0IG1hdGNoZXM9W10sYnVsbGV0aW5NYXRjaGVzPVtdO2NvbnN0IGVzYz14PT5TdHJpbmcoeD8/JycpLnJlcGxhY2UoL1smPD4iJ10vZyxjPT4oeycmJzonJmFtcDsnLCc8JzonJmx0OycsJz4nOicmZ3Q7JywnIic6JyZxdW90OycsIiciOicmIzM5Oyd9W2NdKSk7ZnVuY3Rpb24gYmFyKGxhYmVsLHYsY2xzPScnKXtpZih2PT1udWxsfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcih2KSkpcmV0dXJuIGA8ZGl2IGNsYXNzPSJiYXIiPjxzcGFuPiR7ZXNjKGxhYmVsKX08L3NwYW4+PGRpdiBjbGFzcz0idHJhY2siPjwvZGl2PjxiPuKAlDwvYj48L2Rpdj5gO3Y9TWF0aC5tYXgoMCxNYXRoLm1pbigxMDAsTnVtYmVyKHYpKSk7cmV0dXJuIGA8ZGl2IGNsYXNzPSJiYXIiPjxzcGFuPiR7ZXNjKGxhYmVsKX08L3NwYW4+PGRpdiBjbGFzcz0idHJhY2siPjxkaXYgY2xhc3M9ImZpbGwgJHtjbHN9IiBzdHlsZT0id2lkdGg6JHt2fSUiPjwvZGl2PjwvZGl2PjxiPiR7di50b0ZpeGVkKDEpfSU8L2I+PC9kaXY+YH0KZnVuY3Rpb24gY2FyZChtKXtyZXR1cm4gYDxhcnRpY2xlIGNsYXNzPSJjYXJkIiBpZD0ibSR7TnVtYmVyKG0uaWQpfSI+PGRpdiBjbGFzcz0iaGVhZCI+PHNwYW4+JHtlc2MobS5jb3VudHJ5fHwnJyl9IMK3ICR7ZXNjKG0ubGVhZ3VlfHwnJyl9PC9zcGFuPjxzcGFuPiR7ZXNjKG0uc3RhdHVzPT09J05TJz8nQkHFnkxBTUFESSc6KG0uc3RhdHVzPT09J0ZUJz8nTUHDhyBCxLBUVMSwJzptLnN0YXR1c3x8JycpKX0ke20ubWludXRlIT1udWxsJiYhWydOUycsJ0ZUJ10uaW5jbHVkZXMobS5zdGF0dXMpPycgwrcgJytlc2MobS5taW51dGUpKyInIjonJ308L3NwYW4+PC9kaXY+PGRpdiBjbGFzcz0idGVhbXMiPjxkaXYgY2xhc3M9InRlYW0iPiR7ZXNjKG0uaG9tZSl9PC9kaXY+PGRpdiBjbGFzcz0ic2NvcmUiPiR7ZXNjKG0uaG9tZVNjb3JlPz8n4oCTJyl9IDogJHtlc2MobS5hd2F5U2NvcmU/PyfigJMnKX08L2Rpdj48ZGl2IGNsYXNzPSJ0ZWFtIj4ke2VzYyhtLmF3YXkpfTwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9Im1ldGEiPiR7bS5maXh0dXJlRGF0ZT9uZXcgRGF0ZShtLmZpeHR1cmVEYXRlKS50b0xvY2FsZVN0cmluZygndHItVFInKTonJ308L2Rpdj48ZGl2IGNsYXNzPSJ0YWJzIj48YnV0dG9uIGNsYXNzPSJhY3RpdmUiIG9uY2xpY2s9ImFuYWx5emUoJHtOdW1iZXIobS5pZCl9LCcke20uc3RhdHVzPT09J05TJz8ncHJlbWF0Y2gnOidsaXZlJ30nKSI+TUHDhyBBTkFMxLBaxLA8L2J1dHRvbj48YnV0dG9uIG9uY2xpY2s9InN0YXRzKCR7TnVtYmVyKG0uaWQpfSkiPsSwU1RBVMSwU1TEsEs8L2J1dHRvbj48L2Rpdj48ZGl2IGlkPSJhJHtOdW1iZXIobS5pZCl9Ij48ZGl2IGNsYXNzPSJlbXB0eSI+TWHDpyBhbmFsaXppIGnDp2luIGRva3VuLjwvZGl2PjwvZGl2PjxkaXYgaWQ9InMke051bWJlcihtLmlkKX0iIGNsYXNzPSJoaWRkZW4iPjwvZGl2PjwvYXJ0aWNsZT5gfWZ1bmN0aW9uIHJlbmRlcigpe2xldCBhPSQoJ2ZpbHRlcicpLnZhbHVlPT09J2xpdmUnP21hdGNoZXMuZmlsdGVyKG09PiFbJ0ZUJywnQUVUJywnUEVOJywnTlMnXS5pbmNsdWRlcyhtLnN0YXR1cykpOm1hdGNoZXM7JCgnbWF0Y2hlcycpLmlubmVySFRNTD1hLmxlbmd0aD9hLm1hcChjYXJkKS5qb2luKCcnKTonPGRpdiBjbGFzcz0iZW1wdHkiPkJ1IGxpc3RlZGUgbWHDpyBidWx1bmFtYWTEsS48L2Rpdj4nfWFzeW5jIGZ1bmN0aW9uIGxpdmUoKXsgJCgnbWF0Y2hlcycpLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZW1wdHkiPkNhbmzEsSBtYcOnbGFyIHnDvGtsZW5peW9y4oCmPC9kaXY+Jzt0cnl7bGV0IHI9YXdhaXQgZmV0Y2goJy9hcGkvbGl2ZScpLGo9YXdhaXQgci5qc29uKCk7aWYoIXIub2spdGhyb3cgRXJyb3Ioai5kZXRhaWx8fGouZXJyb3IpO21hdGNoZXM9ai5tYXRjaGVzfHxbXTskKCdjb25uJykudGV4dENvbnRlbnQ9J1NVTlVDVSBCQcSeTEknOyQoJ21zZycpLnRleHRDb250ZW50PWAke21hdGNoZXMubGVuZ3RofSBtYcOnIMK3ICR7bmV3IERhdGUoai5mZXRjaGVkQXR8fERhdGUubm93KCkpLnRvTG9jYWxlVGltZVN0cmluZygndHItVFInKX1gO3JlbmRlcigpfWNhdGNoKGUpeyQoJ2Nvbm4nKS50ZXh0Q29udGVudD0nSEFUQSc7JCgnbXNnJykuaW5uZXJIVE1MPWA8c3BhbiBjbGFzcz0iZXJyIj4ke2VzYyhlLm1lc3NhZ2UpfTwvc3Bhbj5gOyQoJ21hdGNoZXMnKS5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImVtcHR5Ij5NYcOnbGFyIGFsxLFuYW1hZMSxLjwvZGl2Pid9fWFzeW5jIGZ1bmN0aW9uIGJ1bGxldGluKCl7bGV0IGQ9JCgnZGF0ZScpLnZhbHVlO2lmKCFkKXJldHVybjt0cnl7bGV0IHI9YXdhaXQgZmV0Y2goJy9hcGkvZml4dHVyZXM/ZGF0ZT0nK2VuY29kZVVSSUNvbXBvbmVudChkKSksaj1hd2FpdCByLmpzb24oKTtpZighci5vayl0aHJvdyBFcnJvcihqLmRldGFpbHx8ai5lcnJvcik7YnVsbGV0aW5NYXRjaGVzPWoubWF0Y2hlc3x8W107JCgnbWF0Y2hlcycpLmlubmVySFRNTD1idWxsZXRpbk1hdGNoZXMubGVuZ3RoP2J1bGxldGluTWF0Y2hlcy5tYXAoY2FyZCkuam9pbignJyk6JzxkaXYgY2xhc3M9ImVtcHR5Ij5NYcOnIGJ1bHVuYW1hZMSxLjwvZGl2Pic7JCgnbXNnJykudGV4dENvbnRlbnQ9YCR7YnVsbGV0aW5NYXRjaGVzLmxlbmd0aH0gbWHDpyDCtyAke2R9YH1jYXRjaChlKXskKCdtc2cnKS5pbm5lckhUTUw9YDxzcGFuIGNsYXNzPSJlcnIiPiR7ZXNjKGUubWVzc2FnZSl9PC9zcGFuPmB9fWFzeW5jIGZ1bmN0aW9uIHNlYXJjaE1hdGNoKCl7Y29uc3QgcT0kKCdtYXRjaFNlYXJjaCcpLnZhbHVlLnRyaW0oKS50b0xvY2FsZUxvd2VyQ2FzZSgndHItVFInKTtjb25zdCBvdXQ9JCgnbWF0Y2hTZWFyY2hSZXN1bHQnKTtpZighcSl7b3V0LmlubmVySFRNTD0nPHNwYW4gY2xhc3M9ImVyciI+w5ZuY2UgYmlyIHRha8SxbSBhZMSxIHlheiBrcmFsLjwvc3Bhbj4nO3JldHVybn1jb25zdCBkPSQoJ2RhdGUnKS52YWx1ZTtpZighZCl7b3V0LmlubmVySFRNTD0nPHNwYW4gY2xhc3M9ImVyciI+w5ZuY2UgdGFyaWggc2XDpy48L3NwYW4+JztyZXR1cm59b3V0LnRleHRDb250ZW50PSdCw7xsdGVuZGVraSBtYcOnbGFyIGFyYW7EsXlvcuKApic7JCgnc2VhcmNoTWF0Y2gnKS5kaXNhYmxlZD10cnVlO3RyeXtsZXQgc291cmNlPWJ1bGxldGluTWF0Y2hlcztpZighc291cmNlLmxlbmd0aHx8IXNvdXJjZS5zb21lKG09PlN0cmluZyhtLmZpeHR1cmVEYXRlfHwnJykuc2xpY2UoMCwxMCk9PT1kKSl7Y29uc3Qgcj1hd2FpdCBmZXRjaCgnL2FwaS9maXh0dXJlcz9kYXRlPScrZW5jb2RlVVJJQ29tcG9uZW50KGQpLHtzaWduYWw6QWJvcnRTaWduYWwudGltZW91dCgyMDAwMCl9KTtjb25zdCBqPWF3YWl0IHIuanNvbigpO2lmKCFyLm9rKXRocm93IEVycm9yKGouZGV0YWlsfHxqLmVycm9yfHwnQsO8bHRlbiBhbMSxbmFtYWTEsScpO3NvdXJjZT1qLm1hdGNoZXN8fFtdO2J1bGxldGluTWF0Y2hlcz1zb3VyY2V9Y29uc3QgZm91bmQ9c291cmNlLmZpbHRlcihtPT5gJHttLmhvbWV8fCcnfSAke20uYXdheXx8Jyd9YC50b0xvY2FsZUxvd2VyQ2FzZSgndHItVFInKS5pbmNsdWRlcyhxKSk7aWYoIWZvdW5kLmxlbmd0aCl7b3V0LnRleHRDb250ZW50PWDigJwkeyQoJ21hdGNoU2VhcmNoJykudmFsdWUudHJpbSgpfeKAnSBpw6dpbiAke2R9IGLDvGx0ZW5pbmRlIG1hw6cgYnVsdW5hbWFkxLEuYDtyZXR1cm59bWF0Y2hlcz1zb3VyY2U7JCgnZmlsdGVyJykudmFsdWU9J2FsbCc7JCgnbWF0Y2hlcycpLmlubmVySFRNTD1mb3VuZC5tYXAoY2FyZCkuam9pbignJyk7b3V0LnRleHRDb250ZW50PWAke2ZvdW5kLmxlbmd0aH0gZcWfbGXFn2VuIG1hw6cgYnVsdW5kdSDCtyAke2R9LiBBbmFsaXogdmV5YSBpc3RhdGlzdGlrIGnDp2luIG1hw6dhIGRva3VuLmA7JCgnbXNnJykudGV4dENvbnRlbnQ9YEFyYW1hIHNvbnVjdTogJHtmb3VuZC5sZW5ndGh9IG1hw6cgwrcgJHtkfWA7JCgnbWF0Y2hlcycpLnNjcm9sbEludG9WaWV3KHtiZWhhdmlvcjonc21vb3RoJyxibG9jazonc3RhcnQnfSl9Y2F0Y2goZSl7b3V0LmlubmVySFRNTD1gPHNwYW4gY2xhc3M9ImVyciI+QXJhbWEgYmHFn2FyxLFzxLF6OiAke2VzYyhlLm1lc3NhZ2UpfTwvc3Bhbj5gfWZpbmFsbHl7JCgnc2VhcmNoTWF0Y2gnKS5kaXNhYmxlZD1mYWxzZX19ZnVuY3Rpb24gY2xlYXJNYXRjaFNlYXJjaCgpeyQoJ21hdGNoU2VhcmNoJykudmFsdWU9Jyc7JCgnbWF0Y2hTZWFyY2hSZXN1bHQnKS50ZXh0Q29udGVudD0nQXJhbWFrIGnDp2luIHRha8SxbSBhZMSxbsSxIHlhei4nO2J1bGxldGluTWF0Y2hlcz1bXX0KYXN5bmMgZnVuY3Rpb24gYW5hbHl6ZShpZCxtb2RlKXtsZXQgYm94PSQoJ2EnK2lkKTtib3guaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJlbXB0eSI+QW5hbGl6IGVkaWxpeW9y4oCmPC9kaXY+Jzt0cnl7bGV0IHI9YXdhaXQgZmV0Y2goYC9hcGkvbWF0Y2gvJHtpZH0vYW5hbHl6ZT9tb2RlPSR7bW9kZX1gKSxqPWF3YWl0IHIuanNvbigpO2lmKCFyLm9rKXRocm93IEVycm9yKGouZGV0YWlsfHxqLmVycm9yKTtsZXQgcD1qLm1hcmtldFBlcmNlbnRhZ2VzfHx7fTtjb25zdCBwY3Q9KGtleSk9Pntjb25zdCB4PXBba2V5XTtyZXR1cm4geCYmeC5wZXJjZW50IT1udWxsJiZOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHgucGVyY2VudCkpP2AlJHtlc2MoeC5wZXJjZW50KX0gPHNwYW4gY2xhc3M9InNtYWxsIj4ow7ZybmVrbGVtOiAke2VzYyh4LnNhbXBsZVNpemV8fDApfSk8L3NwYW4+YDonVmVyaSB5b2snfTtib3guaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJncmlkIj48ZGl2Pjx0YWJsZSBjbGFzcz0idGFibGUiPjx0cj48dGQ+QU5BIFRFUkPEsEg8L3RkPjx0ZD4ke2VzYyhqLm1haW5QaWNrfHwn4oCUJyl9PC90ZD48L3RyPjx0cj48dGQ+QUxURVJOQVTEsEY8L3RkPjx0ZD4ke2VzYyhqLmFsdGVybmF0aXZlfHwn4oCUJyl9PC90ZD48L3RyPjx0cj48dGQ+xLBZIFNLT1I8L3RkPjx0ZD4ke2VzYyhqLmhhbGZUaW1lU2NvcmV8fCfigJQnKX08L3RkPjwvdHI+PHRyPjx0ZD5NUyBTS09SPC90ZD48dGQ+JHtlc2Moai5mdWxsVGltZVNjb3JlfHwn4oCUJyl9PC90ZD48L3RyPjx0cj48dGQ+U8OcUlBSxLBaPC90ZD48dGQ+JHtlc2Moai5zdXJwcmlzZXx8J+KAlCcpfTwvdGQ+PC90cj48dHI+PHRkPsSwWSAwLjUgw5xTVDwvdGQ+PHRkPiR7cGN0KCdodDA1Jyl9PC90ZD48L3RyPjx0cj48dGQ+xLBZIDEuNSDDnFNUPC90ZD48dGQ+JHtwY3QoJ2h0MTUnKX08L3RkPjwvdHI+PHRyPjx0ZD5FViAxLjUgw5xTVDwvdGQ+PHRkPiR7cGN0KCdob21lMTUnKX08L3RkPjwvdHI+PHRyPjx0ZD5ERVAgMS41IMOcU1Q8L3RkPjx0ZD4ke3BjdCgnYXdheTE1Jyl9PC90ZD48L3RyPjx0cj48dGQ+TVMgMC41IMOcU1Q8L3RkPjx0ZD4ke3BjdCgnbXMwNScpfTwvdGQ+PC90cj48dHI+PHRkPk1TIDEuNSDDnFNUPC90ZD48dGQ+JHtwY3QoJ21zMTUnKX08L3RkPjwvdHI+PHRyPjx0ZD5NUyAyLjUgw5xTVDwvdGQ+PHRkPiR7cGN0KCdtczI1Jyl9PC90ZD48L3RyPjx0cj48dGQ+TVMgMy41IMOcU1Q8L3RkPjx0ZD4ke3BjdCgnbXMzNScpfTwvdGQ+PC90cj48dHI+PHRkPktHIFZBUjwvdGQ+PHRkPiR7cGN0KCdidHRzJyl9PC90ZD48L3RyPjx0cj48dGQ+WcOcWkRFIFZFUsSwU8SwPC90ZD48dGQ+QVBJLUZvb3RiYWxsIGdlcsOnZWsgdGFtYW1sYW5txLHFnyBtYcOnbGFyLjwvdGQ+PC90cj48L3RhYmxlPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9InNtYWxsIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPiR7ZXNjKGoubm90ZXx8J0FuYWxpeiBub3R1IHlvay4nKX08L2Rpdj48ZGl2IGNsYXNzPSJ0b29sYmFyIj48YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBvbmNsaWNrPSJhcHByb3ZlQW5hbHlzaXMoJHtpZH0sJyR7bW9kZX0nKSI+QW5hbGl6aSBPbmF5bGEgdmUgS2F5ZGV0PC9idXR0b24+PC9kaXY+YH1jYXRjaChlKXtib3guaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJzbWFsbCBlcnIiPiR7ZXNjKGUubWVzc2FnZSl9PC9kaXY+YH19CmFzeW5jIGZ1bmN0aW9uIHN0YXRzKGlkKXtsZXQgYj0kKCdzJytpZCk7Yi5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTtiLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZW1wdHkiPsSwc3RhdGlzdGlrIHnDvGtsZW5peW9y4oCmPC9kaXY+Jzt0cnl7bGV0IHI9YXdhaXQgZmV0Y2goYC9hcGkvbWF0Y2gvJHtpZH0vc3RhdHNgKSxqPWF3YWl0IHIuanNvbigpO2lmKCFyLm9rKXRocm93IEVycm9yKGouZXJyb3J8fCfEsHN0YXRpc3RpayBhbMSxbmFtYWTEsScpO2xldCBsaXN0PWouc3RhdHN8fFtdO2lmKCFsaXN0Lmxlbmd0aCl7Yi5pbm5lckhUTUw9JzxkaXYgY2xhc3M9InBhbmVsIj7EsHN0YXRpc3RpayB2ZXJpc2kgYnVsdW5hbWFkxLEuPC9kaXY+JztyZXR1cm47fWIuaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJwYW5lbCI+PGgzPsSwU1RBVMSwU1TEsEs8L2gzPiR7bGlzdC5tYXAodD0+e2xldCBuYW1lPXQudGVhbT8ubmFtZXx8dC50ZWFtfHwnVGFrxLFtJztsZXQgc3RMaXN0PUFycmF5LmlzQXJyYXkodC5zdGF0aXN0aWNzKT90LnN0YXRpc3RpY3M6KHR5cGVvZiB0LnN0YXRpc3RpY3M9PT0nb2JqZWN0Jz9PYmplY3QuZW50cmllcyh0LnN0YXRpc3RpY3MpLm1hcCgoW3R5cGUsdmFsdWVdKT0+KHt0eXBlLHZhbHVlfSkpOltdKTtyZXR1cm4gYDxkaXYgY2xhc3M9InN0YXR0ZWFtIj48Yj4ke2VzYyhuYW1lKX08L2I+JHtzdExpc3QubWFwKHM9PmA8ZGl2IGNsYXNzPSJzdGF0bGluZSI+PHNwYW4+JHtlc2Mocy50eXBlfHwnJyl9PC9zcGFuPjxiPiR7ZXNjKHMudmFsdWU/PyctJyl9PC9iPjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PmB9KS5qb2luKCcnKX08L2Rpdj5gfWNhdGNoKGUpe2IuaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJzbWFsbCBlcnIiPiR7ZXNjKGUubWVzc2FnZSl9PC9kaXY+YH19CmZ1bmN0aW9uIHJlbmRlckNvdXBvbihkKXtjb25zdCBib3g9JCgnY291cG9uUmVzdWx0Jyk7aWYoZC5zdGF0dXM9PT0nRVJST1InfHxkLmVycm9yKXtib3guaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJlcnIiPjxiPiR7ZXNjKGQuZXJyb3J8fCdLdXBvbiBvbHXFn3R1cnVsYW1hZMSxLicpfTwvYj48ZGl2PiR7ZXNjKGQuZGV0YWlsfHwnJyl9PC9kaXY+PC9kaXY+YDtyZXR1cm47fWlmKGQuc3RhdHVzPT09J05PX01BVENIRVMnfHwhZC5waWNrc3x8IWQucGlja3MubGVuZ3RoKXtib3guaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJlcnIiPjxiPiR7ZXNjKGQubWVzc2FnZXx8J1lldGVybGkgc2F5xLFkYSBkb8SfcnVsYW5hYmlsaXIgb3JhbmzEsSBtYcOnIGJ1bHVuYW1hZMSxLicpfTwvYj48ZGl2PiR7ZXNjKGQuZGV0YWlsfHwnJyl9PC9kaXY+PC9kaXY+YDtyZXR1cm47fWNvbnN0IHRnPWQudGVsZWdyYW18fHt9O2NvbnN0IHRnTGFiZWw9dGcuc2VudD8odGcuZHVwbGljYXRlU3VwcHJlc3NlZD8nVGVsZWdyYW06IERhaGEgw7ZuY2UgZ8O2bmRlcmlsZGksIHRla3JhciBlbmdlbGxlbmRpJzonVGVsZWdyYW06IE90b21hdGlrIGfDtm5kZXJpbGRpJyk6KHRnLmVycm9yfHx0Zy5yZWFzb24/YFRlbGVncmFtIGfDtm5kZXJpbGVtZWRpOiAke3RnLmVycm9yfHx0Zy5yZWFzb259YDonVGVsZWdyYW0gZ8O2bmRlcmltIGR1cnVtdSBkb8SfcnVsYW5hbWFkxLEnKTtib3guaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJoZWFkIj48c3Bhbj4ke2QudHlwZT09PSdzdXJwcmlzZScgPyAn8J+OsiBNQcOHIMOWTsOcIFPDnFJQUsSwWiAxMCBNQcOHJyA6IGQudHlwZT09PSdsaXZlJyA/ICfimqEgQ0FOTEkgRU4gR8OcVkVOxLBMxLBSIFRFSyBURVJDxLBIJyA6ICfwn46vIE1Bw4cgw5ZOw5wgS1VQT05VJ30gwrcgJHtlc2MoZC5kYXRlKX08L3NwYW4+PHNwYW4+PGI+JHt0Zy5zZW50PydURUxFR1JBTSBHw5ZOREVSxLBMRMSwJzonR8OWTkRFUsSwTSBLT05UUk9Mw5wnfTwvYj48L3NwYW4+PC9kaXY+PGRpdiBzdHlsZT0ibWFyZ2luOjEwcHggMCI+JHtkLnBpY2tzLm1hcCgocCxpKT0+YDxkaXYgY2xhc3M9InN0YXR0ZWFtIj48ZGl2IGNsYXNzPSJoZWFkIj48c3Bhbj4ke2VzYyhwLmxlYWd1ZSl9PC9zcGFuPjxzcGFuPiR7cC5taW51dGUhPW51bGw/ZXNjKHAubWludXRlKSsiJyDCtyBTa29yOiAiK2VzYyhwLmN1cnJlbnRTY29yZXx8JzAtMCcpOidNYcOnIMO2bsO8J308L3NwYW4+PC9kaXY+PGRpdiBzdHlsZT0iZm9udC13ZWlnaHQ6ODUwO21hcmdpbjo4cHggMCI+JHtlc2MocC5ob21lKX0gVlMgJHtlc2MocC5hd2F5KX08L2Rpdj48ZGl2IGNsYXNzPSJzdGF0bGluZSI+PHNwYW4+VGVyY2loPC9zcGFuPjxiPiR7ZXNjKHAubWFya2V0KX08L2I+PC9kaXY+PGRpdiBjbGFzcz0ic21hbGwiPk9yYW4ga2F5bmHEn8SxOiAke2VzYyhwLnNvdXJjZXx8J0JlbGlydGlsbWVkaScpfSDCtyAke2VzYyhwLm9kZHNCYXNpc3x8J09yYW4ga2F5bmHEn8SxIGRvxJ9ydWxhbm1hbMSxJyl9PC9kaXY+JHtwLnN0YXRzU3VtbWFyeSYmcC5zdGF0c1N1bW1hcnkubGVuZ3RoP2A8ZGl2IGNsYXNzPSJzbWFsbCI+Q2FubMSxIGlzdGF0aXN0aWs6ICR7ZXNjKHAuc3RhdHNTdW1tYXJ5LmpvaW4oJyDCtyAnKSl9PC9kaXY+YDonJ308L2Rpdj5gKS5qb2luKCcnKX08L2Rpdj48ZGl2IGNsYXNzPSJzbWFsbCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4ke2VzYyh0Z0xhYmVsKX0uIEt1cG9uIMO8cmV0aWxkacSfaW5kZSBUZWxlZ3JhbSBnw7ZuZGVyaW1pIG90b21hdGlrIGRlbmVuaXI7IG1hbnVlbCBvbmF5IGdlcmVrbWV6LjwvZGl2PmB9CmFzeW5jIGZ1bmN0aW9uIG1ha2VDb3Vwb24oKXtjb25zdCBiPSQoJ21ha2VDb3Vwb24nKTtiLmRpc2FibGVkPXRydWU7dHJ5e2lmKCEkKCdkYXRlJykudmFsdWUpdGhyb3cgRXJyb3IoJ8OWbmNlIG1hw6cgdGFyaWhpbmkgc2XDpy4nKTtsZXQgcj1hd2FpdCBmZXRjaCgnL2FwaS9jb3Vwb24vYmVzdD9kYXRlPScrZW5jb2RlVVJJQ29tcG9uZW50KCQoJ2RhdGUnKS52YWx1ZSkpO2xldCBkPWF3YWl0IHIuanNvbigpO2lmKCFyLm9rJiYhZC5lcnJvcilkLmVycm9yPSdUZWsgbWHDpyBzZcOnaWxlbWVkaS4nO3JlbmRlckNvdXBvbihkKTtpZihkLm1lc3NhZ2UmJmQuc3RhdHVzPT09J1JFQURZJykkKCdjb3Vwb25SZXN1bHQnKS5pbnNlcnRBZGphY2VudEhUTUwoJ2JlZm9yZWVuZCcsYDxkaXYgY2xhc3M9InNtYWxsIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPiR7ZXNjKGQubWVzc2FnZSl9PC9kaXY+YCk7fWNhdGNoKGUpeyQoJ2NvdXBvblJlc3VsdCcpLmlubmVySFRNTD1gPHNwYW4gY2xhc3M9ImVyciI+JHtlc2MoZS5tZXNzYWdlKX08L3NwYW4+YH1maW5hbGx5e2IuZGlzYWJsZWQ9ZmFsc2U7fX0KYXN5bmMgZnVuY3Rpb24gbWFrZVN1cnByaXNlQ291cG9uKCl7Y29uc3QgYj0kKCdtYWtlU3VycHJpc2VDb3Vwb24nKTtiLmRpc2FibGVkPXRydWU7dHJ5e2lmKCEkKCdkYXRlJykudmFsdWUpdGhyb3cgRXJyb3IoJ8OWbmNlIG1hw6cgdGFyaWhpbmkgc2XDpy4nKTtsZXQgcj1hd2FpdCBmZXRjaCgnL2FwaS9jb3Vwb24vc3VycHJpc2U/ZGF0ZT0nK2VuY29kZVVSSUNvbXBvbmVudCgkKCdkYXRlJykudmFsdWUpKTtsZXQgZD1hd2FpdCByLmpzb24oKTtpZighci5vayYmIWQuZXJyb3IpZC5lcnJvcj0nMTAgbWHDp2zEsWsgc8O8cnByaXoga3Vwb24gb2x1xZ90dXJ1bGFtYWTEsS4nO3JlbmRlckNvdXBvbihkKTtpZihkLm1lc3NhZ2UmJmQuc3RhdHVzPT09J1JFQURZJykkKCdjb3Vwb25SZXN1bHQnKS5pbnNlcnRBZGphY2VudEhUTUwoJ2JlZm9yZWVuZCcsYDxkaXYgY2xhc3M9InNtYWxsIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPiR7ZXNjKGQubWVzc2FnZSl9PC9kaXY+YCk7fWNhdGNoKGUpeyQoJ2NvdXBvblJlc3VsdCcpLmlubmVySFRNTD1gPHNwYW4gY2xhc3M9ImVyciI+JHtlc2MoZS5tZXNzYWdlKX08L3NwYW4+YH1maW5hbGx5e2IuZGlzYWJsZWQ9ZmFsc2U7fX0KYXN5bmMgZnVuY3Rpb24gbWFrZUxpdmVCZXN0KCl7Y29uc3QgYj0kKCdtYWtlTGl2ZUJlc3QnKTtiLmRpc2FibGVkPXRydWU7dHJ5e2xldCBkYXRlPSQoJ2RhdGUnKS52YWx1ZXx8bmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsMTApO2xldCByPWF3YWl0IGZldGNoKCcvYXBpL2NvdXBvbi9saXZlLWJlc3Q/ZGF0ZT0nK2VuY29kZVVSSUNvbXBvbmVudChkYXRlKSk7bGV0IGQ9YXdhaXQgci5qc29uKCk7aWYoIXIub2smJiFkLmVycm9yKWQuZXJyb3I9J0NhbmzEsSB0ZXJjaWggYnVsdW5hbWFkxLEuJztyZW5kZXJDb3Vwb24oZCk7aWYoZC5tZXNzYWdlJiZkLnN0YXR1cz09PSdSRUFEWScpJCgnY291cG9uUmVzdWx0JykuaW5zZXJ0QWRqYWNlbnRIVE1MKCdiZWZvcmVlbmQnLGA8ZGl2IGNsYXNzPSJzbWFsbCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4ke2VzYyhkLm1lc3NhZ2UpfTwvZGl2PmApO31jYXRjaChlKXskKCdjb3Vwb25SZXN1bHQnKS5pbm5lckhUTUw9YDxzcGFuIGNsYXNzPSJlcnIiPiR7ZXNjKGUubWVzc2FnZSl9PC9zcGFuPmB9ZmluYWxseXtiLmRpc2FibGVkPWZhbHNlO319CmFzeW5jIGZ1bmN0aW9uIGFwcHJvdmVBbmFseXNpcyhpZCxtb2RlKXtjb25zdCBtYXRjaD1bLi4ubWF0Y2hlcywuLi5idWxsZXRpbk1hdGNoZXNdLmZpbmQoeD0+TnVtYmVyKHguaWQpPT09TnVtYmVyKGlkKSk7Y29uc3QgYm94PSQoJ2EnK2lkKTtpZighbWF0Y2h8fCFib3gpcmV0dXJuO2NvbnN0IHZhbHM9e307Ym94LnF1ZXJ5U2VsZWN0b3JBbGwoJy50YWJsZSB0cicpLmZvckVhY2gocm93PT57Y29uc3QgYz1yb3cucXVlcnlTZWxlY3RvckFsbCgndGQnKTtpZihjLmxlbmd0aD09PTIpdmFsc1tjWzBdLnRleHRDb250ZW50LnRyaW0oKV09Y1sxXS50ZXh0Q29udGVudC50cmltKCl9KTtjb25zdCBhbmFseXNpcz17bWFpblBpY2s6dmFsc1snQU5BIFRFUkPEsEgnXXx8J+KAlCcsYWx0ZXJuYXRpdmU6dmFsc1snQUxURVJOQVTEsEYnXXx8J+KAlCcsaGFsZlRpbWVTY29yZTp2YWxzWyfEsFkgU0tPUiddfHwn4oCUJyxmdWxsVGltZVNjb3JlOnZhbHNbJ01TIFNLT1InXXx8J+KAlCcsc3VycHJpc2U6dmFsc1snU8OcUlBSxLBaJ118fCfigJQnfTt0cnl7YXdhaXQgZmV0Y2goJy9hcGkvYW5hbHlzZXMvYXBwcm92ZScse21ldGhvZDonUE9TVCcsaGVhZGVyczp7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSxib2R5OkpTT04uc3RyaW5naWZ5KHtmaXh0dXJlSWQ6TnVtYmVyKGlkKSxtYXRjaERhdGU6bWF0Y2guZml4dHVyZURhdGV8fCcnLGhvbWU6bWF0Y2guaG9tZSxhd2F5Om1hdGNoLmF3YXksYW5hbHlzaXN9KX0pO2FsZXJ0KCdBbmFsaXogb25heWxhbmTEsS4nKTt9Y2F0Y2goZSl7YWxlcnQoJ0hhdGE6ICcrZS5tZXNzYWdlKTt9fQpmdW5jdGlvbiBjbG9zZUFyY2hpdmVzKCl7JCgnYW5hbHlzZXNBcmNoaXZlJykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7JCgnY291cG9uc0FyY2hpdmUnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTt9CmFzeW5jIGZ1bmN0aW9uIGxvYWRBcmNoaXZlcyh3aGljaCl7Y29uc3QgYm94PSQod2hpY2g9PT0nYW5hbHlzaXMnPydhbmFseXNlc0FyY2hpdmVMaXN0JzonY291cG9uc0FyY2hpdmVMaXN0Jyk7Ym94LnRleHRDb250ZW50PSdZw7xrbGVuaXlvcuKApic7dHJ5e2xldCByPWF3YWl0IGZldGNoKCcvYXBpL2FyY2hpdmVzJyksaj1hd2FpdCByLmpzb24oKTtpZih3aGljaD09PSdhbmFseXNpcycpe2JveC5pbm5lckhUTUw9KGouYW5hbHlzZXN8fFtdKS5sZW5ndGg/ai5hbmFseXNlcy5tYXAoeD0+YDxkaXYgY2xhc3M9ImFyY2hpdmUtaXRlbSI+PGRpdiBjbGFzcz0idGl0bGUiPiR7ZXNjKHguaG9tZV90ZWFtKX0gVlMgJHtlc2MoeC5hd2F5X3RlYW0pfTwvZGl2PjxkaXYgY2xhc3M9InJvd2xpbmUiPjxzcGFuPkFuYSB0ZXJjaWg8L3NwYW4+PGI+JHtlc2MoeC5hbmFseXNpcz8ubWFpblBpY2t8fCfigJQnKX08L2I+PC9kaXY+PGRpdiBjbGFzcz0icm93bGluZSI+PHNwYW4+xLBZIC8gTVMgc2tvcjwvc3Bhbj48Yj4ke2VzYyh4LmFuYWx5c2lzPy5oYWxmVGltZVNjb3JlfHwn4oCUJyl9IC8gJHtlc2MoeC5hbmFseXNpcz8uZnVsbFRpbWVTY29yZXx8J+KAlCcpfTwvYj48L2Rpdj48L2Rpdj5gKS5qb2luKCcnKTonPGRpdiBjbGFzcz0iZW1wdHkiPkthecSxdCB5b2suPC9kaXY+Jzt9ZWxzZXtib3guaW5uZXJIVE1MPShqLmNvdXBvbnN8fFtdKS5sZW5ndGg/ai5jb3Vwb25zLm1hcCh4PT5gPGRpdiBjbGFzcz0iYXJjaGl2ZS1pdGVtIj48ZGl2IGNsYXNzPSJ0aXRsZSI+JHt4LmlzTGl2ZT8n8J+OryBDYW5sxLEgS29tYmluJzonS3Vwb24nfSDCtyAke2VzYyh4LmRhdGV8fCcnKX08L2Rpdj48L2Rpdj5gKS5qb2luKCcnKTonPGRpdiBjbGFzcz0iZW1wdHkiPkthecSxdCB5b2suPC9kaXY+Jzt9fWNhdGNoKGUpe2JveC5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImVyciI+JHtlc2MoZS5tZXNzYWdlKX1gIH19CndpbmRvdy5hbmFseXplPWFuYWx5emU7d2luZG93LnN0YXRzPXN0YXRzOyQoJ3JlZnJlc2gnKS5vbmNsaWNrPWxpdmU7JCgnYnVsbGV0aW4nKS5vbmNsaWNrPWJ1bGxldGluOyQoJ3NlYXJjaE1hdGNoJykub25jbGljaz1zZWFyY2hNYXRjaDskKCdtYXRjaFNlYXJjaCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLGU9PntpZihlLmtleT09PSdFbnRlcicpc2VhcmNoTWF0Y2goKX0pOyQoJ2NsZWFyTWF0Y2hTZWFyY2gnKS5vbmNsaWNrPWNsZWFyTWF0Y2hTZWFyY2g7JCgnbWFrZUNvdXBvbicpLm9uY2xpY2s9bWFrZUNvdXBvbjskKCdtYWtlU3VycHJpc2VDb3Vwb24nKS5vbmNsaWNrPW1ha2VTdXJwcmlzZUNvdXBvbjskKCdtYWtlTGl2ZUJlc3QnKS5vbmNsaWNrPW1ha2VMaXZlQmVzdDskKCdzaG93QW5hbHlzZXMnKS5vbmNsaWNrPSgpPT57Y2xvc2VBcmNoaXZlcygpOyQoJ2FuYWx5c2VzQXJjaGl2ZScpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpO2xvYWRBcmNoaXZlcygnYW5hbHlzaXMnKTt9OyQoJ3Nob3dDb3Vwb25zJykub25jbGljaz0oKT0+e2Nsb3NlQXJjaGl2ZXMoKTskKCdjb3Vwb25zQXJjaGl2ZScpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpO2xvYWRBcmNoaXZlcygnY291cG9uJyk7fTskKCdmaWx0ZXInKS5vbmNoYW5nZT1yZW5kZXI7bGV0IGQ9bmV3IERhdGUoKTskKCdkYXRlJykudmFsdWU9YCR7ZC5nZXRGdWxsWWVhcigpfS0ke1N0cmluZyhkLmdldE1vbnRoKCkrMSkucGFkU3RhcnQoMiwnMCcpfS0ke1N0cmluZyhkLmdldERhdGUoKSkucGFkU3RhcnQoMiwnMCcpfWA7bGl2ZSgpOwo8L3NjcmlwdD48L2JvZHk+PC9odG1sPg==", "base64").toString("utf8");
app.get("/", async (_req, res) => {
  try {
    const html = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
    return res.type("html").send(html);
  } catch {
    return res.type("html").send(EMBEDDED_INDEX_HTML);
  }
});
app.use(express.static(path.join(ROOT, "public")));

const providerCache = new Map();
const providerInFlight = new Map();
const archives = { analyses: [], coupons: [] };
// Otomatik canlı tercihler için sonuç takibi (bellek tabanlı; kalıcı DB henüz bağlı değil).
const livePredictionRecords = new Map();
// Aynı kuponun art arda tıklama/yenilemelerde tekrar Telegram'a gitmesini önler.
const telegramDeliveryCache = new Map();
// Otomatik gönderimde aynı gün aynı maçı tekrar seçmemek için takip edilir.
const autoSentFixtureKeys = new Set();
let autoLiveTaskInFlight = false;
let autoPrematchTaskInFlight = false;
// Telegram'a gönderilmiş kuponlardaki maçlar için gol/skor değişimi takibi.
// Not: Bu izleme durumu bellektedir; süreç yeniden başlarsa kupon yeniden gönderilince takip tekrar kurulur.
const goalTrackedFixtures = new Map();
const goalScoreCache = new Map();
let goalScanInFlight = false;
// API-Football plan limitine takılmamak için istekleri tek kuyruktan geçir.
// 260 ms aralık yaklaşık 231 istek/dk ile 300/dk sınırının altında kalır.
let providerQueue = Promise.resolve();
let lastProviderRequestAt = 0;
let providerCooldownUntil = 0;
const PROVIDER_MIN_INTERVAL_MS = 260;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function cachedProviderRequest(cacheKey, pathname, ttlMs = 30000) {
  const now = Date.now();
  const cached = providerCache.get(cacheKey);
  if (cached && now - cached.at < ttlMs) return cached.payload;
  if (providerInFlight.has(cacheKey)) return providerInFlight.get(cacheKey);
  if (!API_KEY) throw new Error("Render Environment Variables içinde API_FOOTBALL_KEY eksik.");

  const task = providerQueue.then(async () => {
    const secondCheck = providerCache.get(cacheKey);
    if (secondCheck && Date.now() - secondCheck.at < ttlMs) return secondCheck.payload;
    const allowedAt = Math.max(lastProviderRequestAt + PROVIDER_MIN_INTERVAL_MS, providerCooldownUntil);
    if (allowedAt > Date.now()) await delay(allowedAt - Date.now());
    lastProviderRequestAt = Date.now();
    const response = await fetch(`${BASE_URL}${pathname}`, {
      headers: { "x-apisports-key": API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { throw new Error("API-Football geçerli JSON döndürmedi."); }
    const errors = payload.errors && Object.keys(payload.errors).length ? payload.errors : null;
    const errorText = errors ? JSON.stringify(errors) : "";
    if (!response.ok || errors) {
      if (response.status === 429 || /rate.?limit|too many requests|per-minute/i.test(errorText)) {
        providerCooldownUntil = Date.now() + 15000;
        throw new Error(`API-Football istek sınırına ulaşıldı; 15 saniye bekleme uygulandı. ${errorText}`);
      }
      throw new Error(`API-Football hatası: ${errors ? errorText : `HTTP ${response.status}`}`);
    }
    providerCache.set(cacheKey, { at: Date.now(), payload });
    // Bellek kullanımını sınırlı tut.
    if (providerCache.size > 2500) {
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      for (const [key, value] of providerCache) if (value.at < cutoff) providerCache.delete(key);
      while (providerCache.size > 2000) providerCache.delete(providerCache.keys().next().value);
    }
    return payload;
  });
  providerQueue = task.catch(() => undefined);
  providerInFlight.set(cacheKey, task);
  try { return await task; }
  finally { providerInFlight.delete(cacheKey); }
}

function normalizeProviderMatch(match) {
  const homeName = match.teams?.home?.name || match.home || "Ev sahibi";
  const awayName = match.teams?.away?.name || match.away || "Deplasman";
  const leagueName = match.league?.name || match.league || "Lig";
  const countryName = match.league?.country || match.country || "";
  const idNum = Number(match.fixture?.id ?? match.id) || 0;
  let status = String(match.fixture?.status?.short || match.status || "NS").toUpperCase();
  if (["FT", "AET", "PEN"].includes(status)) status = "FT";
  else if (["1H", "2H", "HT", "LIVE", "IN_PLAY", "ET", "BT", "P"].includes(status)) status = "LIVE";
  else if (["NS", "TBD", "PST", "CANC", "ABD", "AWD", "WO"].includes(status)) status = status === "NS" ? "NS" : status;
  return {
    id: idNum, homeId: Number(match.teams?.home?.id) || null, awayId: Number(match.teams?.away?.id) || null,
    league: String(leagueName), country: String(countryName),
    minute: match.fixture?.status?.elapsed ?? match.minute ?? null, status,
    home: String(homeName), away: String(awayName),
    homeScore: match.goals?.home ?? 0, awayScore: match.goals?.away ?? 0,
    htHomeScore: match.score?.halftime?.home ?? null, htAwayScore: match.score?.halftime?.away ?? null,
    fixtureDate: match.fixture?.date || match.kickoff_utc || null
  };
}

function computeAnalysis(match) {
  const minute = Number(match.minute || 0);
  const home = Number(match.homeScore || 0), away = Number(match.awayScore || 0);
  const total = home + away, live = match.status === "LIVE", finished = match.status === "FT";
  let ht = "Tahmin: veri yetersiz", ft = "Tahmin: veri yetersiz", mainPick = "UZAK DUR", alternative = "UZAK DUR";
  if (finished) {
    ht = `${match.htHomeScore ?? "?"}-${match.htAwayScore ?? "?"}`;
    ft = `${home}-${away}`;
  } else if (live) {
    if (minute >= 45 && match.htHomeScore != null && match.htAwayScore != null) ht = `${match.htHomeScore}-${match.htAwayScore} (İY Gerçek)`;
    else if (minute < 45 && total > 0) ht = `Tahmin: ${home}-${away}`;
    else if (minute <= 30) ht = "Tahmin: 1-0";
    else ht = "Tahmin: 0-0";
    ft = minute >= 75 ? `Tahmin: ${home}-${away}` : `Tahmin: ${home + 1}-${away}`;
    if (minute < 33 && total === 0) { mainPick = "İY 0.5 ÜST"; alternative = "MS 1.5 ÜST"; }
    else if (minute >= 33 && minute < 45 && total === 0) { mainPick = "MS 1.5 ÜST"; alternative = "UZAK DUR"; }
    else if (minute >= 45 && total < 2) { mainPick = "MS 1.5 ÜST"; alternative = "UZAK DUR"; }
    else { mainPick = "UZAK DUR"; alternative = "UZAK DUR"; }
  } else {
    ht = "Tahmin: oran/veri analizi gerekli";
    ft = "Tahmin: oran/veri analizi gerekli";
    mainPick = "UZAK DUR"; alternative = "UZAK DUR";
  }
  return { halfTimeScore: ht, fullTimeScore: ft, mainPick, alternative, surprise: "Veri desteklemediği için sürpriz tahmin üretilmedi" };
}

function bookmakerRows(oddsRow) {
  if (!oddsRow) return [];
  if (Array.isArray(oddsRow.bookmakers) && oddsRow.bookmakers.length) return oddsRow.bookmakers;
  if (Array.isArray(oddsRow.odds) && oddsRow.odds.length) {
    return [{
      name: oddsRow.bookmaker?.name || oddsRow.bookmaker || oddsRow.source || "API-Football",
      bets: oddsRow.odds.map(item => ({ name: item.name || item.bet || "", values: item.values || [] }))
    }];
  }
  return [];
}

function oddsForFixture(oddsRow) {
  const markets = new Map();
  const add = (book, key, side, odd) => {
    if (!Number.isFinite(odd) || odd <= 1.01) return;
    const mapKey = `${book}|${key}`;
    if (!markets.has(mapKey)) markets.set(mapKey, { market: key, bookmaker: book, over: null, under: null, yes: null, no: null, home: null, draw: null, away: null });
    const item = markets.get(mapKey);
    item[side] = odd;
  };
  for (const bookmaker of bookmakerRows(oddsRow)) {
    const book = String(bookmaker.name || "Kaynak belirtilmedi");
    for (const bet of (bookmaker.bets || [])) {
      const name = String(bet.name || "").toLowerCase().replace(/[–—]/g, "-");
      const isHalf = /first half|1st half|half.?time|1st period|first period/.test(name);
      const isHomeTeam = /home team|home goals|team 1 total|team 1 goals|team total - home/.test(name);
      const isAwayTeam = /away team|away goals|team 2 total|team 2 goals|team total - away/.test(name);
      const isBtts = /both teams to score|both teams score|btts/.test(name);
      const isTotal = /over.?under|total goals|match goals|goal line|goals total|total/.test(name) && !isHomeTeam && !isAwayTeam;
      const isWinner = /match winner|1x2|full.?time result|match result|regular time result|winner/.test(name);
      for (const value of (bet.values || [])) {
        const label = String(value.value ?? value.name ?? "").toLowerCase().trim();
        const odd = Number(value.odd);
        if (!Number.isFinite(odd) || odd <= 1.01) continue;
        if (isWinner) {
          if (/^(home|1|team 1|1 \(home\))$/.test(label)) add(book, "MS 1", "home", odd);
          else if (/^(draw|x|tie)$/.test(label)) add(book, "MS 1", "draw", odd);
          else if (/^(away|2|team 2|2 \(away\))$/.test(label)) add(book, "MS 1", "away", odd);
          continue;
        }
        if (isBtts) {
          if (/^(yes|y|both teams to score - yes)$/.test(label)) add(book, "KG VAR", "yes", odd);
          else if (/^(no|n|both teams to score - no)$/.test(label)) add(book, "KG VAR", "no", odd);
          continue;
        }
        const overMatch = label.match(/over\s*([0-9]+[.,][0-9]+)/);
        const underMatch = label.match(/under\s*([0-9]+[.,][0-9]+)/);
        const lineMatch = label.match(/([0-9]+[.,][0-9]+)/);
        const line = (overMatch || underMatch || lineMatch)?.[1]?.replace(',', '.');
        if (!line) continue;
        const side = overMatch ? "over" : underMatch ? "under" : null;
        if (!side) continue;
        let key = null;
        if (isHomeTeam && Number(line) === 1.5) key = "EV 1.5 ÜST";
        else if (isAwayTeam && Number(line) === 1.5) key = "DEP 1.5 ÜST";
        else if (isHalf && [0.5, 1.5, 2.5].includes(Number(line))) key = `İY ${line} ÜST`;
        else if (isTotal && [0.5, 1.5, 2.5, 3.5].includes(Number(line))) key = `MS ${line} ÜST`;
        if (key) add(book, key, side, odd);
      }
    }
  }
  const candidates = [];
  for (const item of markets.values()) {
    let pct = null;
    if (item.over && item.under) pct = 100 * (1 / item.over) / ((1 / item.over) + (1 / item.under));
    else if (item.yes && item.no) pct = 100 * (1 / item.yes) / ((1 / item.yes) + (1 / item.no));
    else if (item.home && item.draw && item.away) {
      const inv = [1 / item.home, 1 / item.draw, 1 / item.away], sum = inv.reduce((a,b)=>a+b,0);
      pct = 100 * inv[0] / sum;
    }
    const odd = item.over || item.yes || item.home;
    if (pct == null || !Number.isFinite(pct)) continue;
    const ranks = { "EV 1.5 ÜST": 1, "DEP 1.5 ÜST": 1, "İY 0.5 ÜST": 2, "MS 0.5 ÜST": 2, "İY 1.5 ÜST": 3, "MS 1.5 ÜST": 3, "MS 2.5 ÜST": 4, "KG VAR": 5, "MS 3.5 ÜST": 6 };
    candidates.push({ market: item.market, odd, probability: pct, rank: ranks[item.market] ?? 9, bookmaker: item.bookmaker,
      homeOdd: item.market === "MS 1" ? item.home : null, drawOdd: item.market === "MS 1" ? item.draw : null,
      awayOdd: item.market === "MS 1" ? item.away : null });
  }
  // If API-Football has multiple bookmakers, keep each book's pair intact and prefer Bet365 only as a tie-break.
  return candidates.sort((a,b) => b.probability-a.probability || (/bet365/i.test(b.bookmaker)-/bet365/i.test(a.bookmaker)) || a.rank-b.rank);
}

function marketSupport(market, homeForm, awayForm) {
  if (!homeForm?.available || !awayForm?.available) return null;
  const avg = (a,b) => a == null || b == null ? null : (Number(a)+Number(b))/2;
  if (market === "EV 1.5 ÜST") return 0.65*Number(homeForm.teamGoalsOver15Pct ?? 0) + 0.35*Number(awayForm.goalsConcededPct ?? 0);
  if (market === "DEP 1.5 ÜST") return 0.65*Number(awayForm.teamGoalsOver15Pct ?? 0) + 0.35*Number(homeForm.goalsConcededPct ?? 0);
  if (market === "MS 2.5 ÜST") return avg(homeForm.over25Pct, awayForm.over25Pct);
  if (market === "MS 3.5 ÜST") return avg(homeForm.over35Pct, awayForm.over35Pct);
  if (market === "MS 1.5 ÜST") return avg(homeForm.over15Pct, awayForm.over15Pct);
  if (market === "MS 0.5 ÜST") return avg(homeForm.over05Pct, awayForm.over05Pct);
  if (market === "KG VAR") return avg(homeForm.bttsPct, awayForm.bttsPct);
  if (market === "İY 0.5 ÜST") return avg(homeForm.htOver05Pct, awayForm.htOver05Pct);
  if (market === "İY 1.5 ÜST") return avg(homeForm.htOver15Pct, awayForm.htOver15Pct);
  return null;
}

async function fetchTeamRecentForm(teamId, fixtureId) {
  if (!teamId) return { available: false, sampleSize: 0 };
  try {
    const payload = await cachedProviderRequest(`form:${teamId}`, `/fixtures?team=${teamId}&last=10`, 6 * 60 * 60 * 1000);
    const rows = (payload.response || []).filter(row => Number(row.fixture?.id) !== Number(fixtureId) &&
      ["FT", "AET", "PEN"].includes(String(row.fixture?.status?.short || "").toUpperCase()) &&
      row.goals?.home != null && row.goals?.away != null)
      .sort((a,b) => new Date(b.fixture?.date || 0) - new Date(a.fixture?.date || 0)).slice(0,5);
    if (rows.length < 5) return { available: false, sampleSize: rows.length };
    const pct = fn => Math.round(100 * vals.filter(fn).length / vals.length);
    const vals = rows.map(r => {
      const isHome = Number(r.teams?.home?.id) === Number(teamId);
      const gf = Number(isHome ? r.goals.home : r.goals.away);
      const ga = Number(isHome ? r.goals.away : r.goals.home);
      const total = Number(r.goals.home) + Number(r.goals.away);
      const hth = r.score?.halftime?.home, hta = r.score?.halftime?.away;
      return { gf, ga, total, btts: Number(r.goals.home)>0 && Number(r.goals.away)>0,
        htTotal: hth == null || hta == null ? null : Number(hth)+Number(hta) };
    });
    const htVals = vals.filter(x => x.htTotal != null);
    return {
      available: true, sampleSize: rows.length,
      teamGoalsOver15Pct: pct(x => x.gf >= 2),
      goalsConcededPct: pct(x => x.ga > 0),
      over05Pct: pct(x => x.total >= 1), over15Pct: pct(x => x.total >= 2),
      over25Pct: pct(x => x.total >= 3), over35Pct: pct(x => x.total >= 4),
      bttsPct: pct(x => x.btts),
      htOver05Pct: htVals.length ? Math.round(100 * htVals.filter(x=>x.htTotal>=1).length / htVals.length) : null,
      htOver15Pct: htVals.length ? Math.round(100 * htVals.filter(x=>x.htTotal>=2).length / htVals.length) : null,
      avgGoalsFor: Number((vals.reduce((sum,x)=>sum+x.gf,0)/vals.length).toFixed(2)),
      avgGoalsAgainst: Number((vals.reduce((sum,x)=>sum+x.ga,0)/vals.length).toFixed(2)),
      avgTotalGoals: Number((vals.reduce((sum,x)=>sum+x.total,0)/vals.length).toFixed(2)),
      matches: rows.map(r=>({score:`${r.goals.home}-${r.goals.away}`, halftimeScore:r.score?.halftime?.home==null?null:`${r.score.halftime.home}-${r.score.halftime.away}`}))
    };
  } catch (e) {
    console.warn(`[Team form] team=${teamId}: ${e.message}`);
    return { available: false, sampleSize: 0 };
  }
}

function liveStatsMetrics(stats, fixture) {
  const out = { available: Array.isArray(stats) && stats.length >= 2, shotsOnTarget: 0, totalShots: 0, corners: 0,
    home: { shotsOnTarget: 0, totalShots: 0, corners: 0 }, away: { shotsOnTarget: 0, totalShots: 0, corners: 0 } };
  for (const team of (stats || [])) {
    const side = Number(team.team?.id) === Number(fixture.homeId) ? "home" : "away";
    for (const st of (team.statistics || [])) {
      const type = String(st.type || "").toLowerCase();
      const value = Number(String(st.value ?? "0").replace('%','')) || 0;
      if (/shots on goal|shots on target/.test(type)) { out.shotsOnTarget += value; out[side].shotsOnTarget += value; }
      if (/total shots|goal attempts/.test(type)) { out.totalShots += value; out[side].totalShots += value; }
      if (/corner kicks|corners/.test(type)) { out.corners += value; out[side].corners += value; }
    }
  }
  out.pressure = out.shotsOnTarget*2.5 + out.totalShots*0.45 + out.corners*0.8;
  return out;
}

function poissonProbabilityAtLeast(threshold, lambda, currentGoals = 0) {
  const need = Number(threshold) - Number(currentGoals || 0);
  if (need <= 0) return 1;
  let cumulative = 0;
  for (let k = 0; k < need; k++) cumulative += Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
  return Math.max(0, Math.min(1, 1 - cumulative));
}
function factorial(n) { let out = 1; for (let i = 2; i <= n; i++) out *= i; return out; }
function lambdaFromMarketProbability(probability, threshold, currentGoals = 0) {
  const p = Number(probability);
  if (!Number.isFinite(p) || p <= 0.01 || p >= 0.99 || Number(currentGoals || 0) >= Number(threshold)) return null;
  let low = 0, high = 8;
  for (let i = 0; i < 50; i++) {
    const mid = (low + high) / 2;
    if (poissonProbabilityAtLeast(threshold, mid, currentGoals) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
function marketProbabilitiesByName(oddsRow) {
  const rows = oddsForFixture(oddsRow);
  const grouped = new Map();
  for (const row of rows) {
    if (!Number.isFinite(Number(row.probability))) continue;
    if (!grouped.has(row.market)) grouped.set(row.market, []);
    grouped.get(row.market).push(Number(row.probability) / 100);
  }
  const result = {};
  for (const [market, values] of grouped) {
    // Birden fazla bahis şirketi varsa olasılıkları ortala; oran değerlerini kullanıcıya açma.
    result[market] = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  return result;
}
function scorePrediction(fixture, homeForm, awayForm, liveOddsRow = null, prematchOddsRow = null) {
  const hNow = Number(fixture.homeScore || 0), aNow = Number(fixture.awayScore || 0);
  const live = fixture.status === "LIVE";
  if (fixture.status === "FT") return { halfTimeScore: `${fixture.htHomeScore ?? "?"}-${fixture.htAwayScore ?? "?"}`, fullTimeScore: `${hNow}-${aNow}`, scoreBasis: "Gerçekleşen skor" };
  if (!homeForm?.available || !awayForm?.available) return { halfTimeScore: "Form verisi bulunamadı", fullTimeScore: "Skor tahmini için veri yetersiz", scoreBasis: "Son 5 maç formu eksik" };

  const pre = marketProbabilitiesByName(prematchOddsRow);
  const liveMarkets = live ? marketProbabilitiesByName(liveOddsRow) : {};
  const hasLiveMarket = live && Object.keys(liveMarkets).length > 0;
  const market = hasLiveMarket ? liveMarkets : pre;
  const currentTotal = hNow + aNow;
  const minute = Math.max(0, Math.min(90, Number(fixture.minute || 0)));
  const remainingFraction = live ? Math.max(0.05, (90 - minute) / 90) : 1;

  // Maç önü piyasa olasılıklarından tam maç gol beklentisi çıkarılır.
  const preHomeMarket = lambdaFromMarketProbability(pre["EV 1.5 ÜST"], 2, 0);
  const preAwayMarket = lambdaFromMarketProbability(pre["DEP 1.5 ÜST"], 2, 0);
  const preTotalCandidates = [
    lambdaFromMarketProbability(pre["MS 1.5 ÜST"], 2, 0),
    lambdaFromMarketProbability(pre["MS 2.5 ÜST"], 3, 0),
    lambdaFromMarketProbability(pre["MS 3.5 ÜST"], 4, 0)
  ].filter(Number.isFinite);
  const preTotal = preTotalCandidates.length ? preTotalCandidates.reduce((a,b)=>a+b,0) / preTotalCandidates.length : null;

  // Canlı toplam gol ve takım gol pazarları mevcut skor koşulunda kalan gol beklentisine çevrilir.
  let homeMarketLambda = hasLiveMarket ? lambdaFromMarketProbability(liveMarkets["EV 1.5 ÜST"], 2, hNow) : null;
  let awayMarketLambda = hasLiveMarket ? lambdaFromMarketProbability(liveMarkets["DEP 1.5 ÜST"], 2, aNow) : null;
  const liveTotalCandidates = hasLiveMarket ? [
    lambdaFromMarketProbability(liveMarkets["MS 1.5 ÜST"], 2, currentTotal),
    lambdaFromMarketProbability(liveMarkets["MS 2.5 ÜST"], 3, currentTotal),
    lambdaFromMarketProbability(liveMarkets["MS 3.5 ÜST"], 4, currentTotal)
  ].filter(Number.isFinite) : [];
  let totalRemainingMarket = liveTotalCandidates.length ? liveTotalCandidates.reduce((a,b)=>a+b,0) / liveTotalCandidates.length : null;

  const formHomeFull = Math.max(0.15, 0.58 * Number(homeForm.avgGoalsFor || 0) + 0.42 * Number(awayForm.avgGoalsAgainst || 0));
  const formAwayFull = Math.max(0.15, 0.58 * Number(awayForm.avgGoalsFor || 0) + 0.42 * Number(homeForm.avgGoalsAgainst || 0));
  let lambdaHome, lambdaAway;
  if (live) {
    // Canlı oranlar varsa öncelik canlı pazarda; kapanış/maç önü referansı sadece eksik pazarları destekler.
    const formHomeRemaining = formHomeFull * remainingFraction;
    const formAwayRemaining = formAwayFull * remainingFraction;
    if (homeMarketLambda == null && preHomeMarket != null) homeMarketLambda = preHomeMarket * remainingFraction;
    if (awayMarketLambda == null && preAwayMarket != null) awayMarketLambda = preAwayMarket * remainingFraction;
    if (homeMarketLambda == null && totalRemainingMarket != null && awayMarketLambda != null) homeMarketLambda = Math.max(0.05, totalRemainingMarket - awayMarketLambda);
    if (awayMarketLambda == null && totalRemainingMarket != null && homeMarketLambda != null) awayMarketLambda = Math.max(0.05, totalRemainingMarket - homeMarketLambda);
    if (homeMarketLambda == null) homeMarketLambda = formHomeRemaining;
    if (awayMarketLambda == null) awayMarketLambda = formAwayRemaining;
    if (totalRemainingMarket != null && homeMarketLambda + awayMarketLambda > 0) {
      const scale = totalRemainingMarket / (homeMarketLambda + awayMarketLambda);
      homeMarketLambda *= scale; awayMarketLambda *= scale;
    }
    lambdaHome = hasLiveMarket ? 0.75 * homeMarketLambda + 0.25 * formHomeRemaining : homeMarketLambda;
    lambdaAway = hasLiveMarket ? 0.75 * awayMarketLambda + 0.25 * formAwayRemaining : awayMarketLambda;
  } else {
    let h = preHomeMarket, a = preAwayMarket;
    if (h == null && a == null && preTotal != null) {
      const sum = formHomeFull + formAwayFull;
      h = preTotal * formHomeFull / Math.max(0.01, sum);
      a = preTotal * formAwayFull / Math.max(0.01, sum);
    } else if (h == null && preTotal != null) h = Math.max(0.1, preTotal - a);
    else if (a == null && preTotal != null) a = Math.max(0.1, preTotal - h);
    lambdaHome = h == null ? formHomeFull : 0.75 * h + 0.25 * formHomeFull;
    lambdaAway = a == null ? formAwayFull : 0.75 * a + 0.25 * formAwayFull;
    if (preTotal != null && lambdaHome + lambdaAway > 0) {
      const target = 0.65 * preTotal + 0.35 * (lambdaHome + lambdaAway);
      const scale = target / (lambdaHome + lambdaAway);
      lambdaHome *= scale; lambdaAway *= scale;
    }
  }

  // Olası skorları bağımsız Poisson gol dağılımıyla sıralar; canlıda mevcut skorun altına inemez.
  const pmf = (k, lambda) => Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
  let best = null;
  const maxExtra = 6;
  for (let gh = 0; gh <= maxExtra; gh++) for (let ga = 0; ga <= maxExtra; ga++) {
    const probability = pmf(gh, Math.max(0.01, lambdaHome)) * pmf(ga, Math.max(0.01, lambdaAway));
    const finalH = live ? hNow + gh : gh;
    const finalA = live ? aNow + ga : ga;
    if (!best || probability > best.probability) best = { finalH, finalA, probability };
  }
  const fullTimeScore = best ? `${best.finalH}-${best.finalA} (tahmin)` : "Skor tahmini için veri yetersiz";
  let halfTimeScore;
  if (live && minute >= 45 && fixture.htHomeScore != null && fixture.htAwayScore != null) halfTimeScore = `${fixture.htHomeScore}-${fixture.htAwayScore} (Gerçek)`;
  else if (live && minute < 45) halfTimeScore = `${hNow}-${aNow} (canlı skor; İY tahmini ayrı doğrulanmadı)`;
  else halfTimeScore = `${Math.max(0, Math.round(lambdaHome * 0.46))}-${Math.max(0, Math.round(lambdaAway * 0.46))} (tahmin)`;
  const basis = hasLiveMarket ? "Canlı oranlar + maç önü referansı + son 5 maç formu" : (Object.keys(pre).length ? "Maç önü oran referansı (resmî kapanış olduğu doğrulanmadı) + son 5 maç formu" : "Son 5 maç formu; kullanılabilir oran pazarı bulunamadı");
  return { halfTimeScore, fullTimeScore, scoreBasis: basis, scoreProbability: best ? Number(best.probability.toFixed(4)) : null };
}

function analysisPercentages(oddsRow, homeForm, awayForm) {
  const map = { ht05: "İY 0.5 ÜST", ht15: "İY 1.5 ÜST", ms05: "MS 0.5 ÜST", ms15: "MS 1.5 ÜST", ms25: "MS 2.5 ÜST", ms35: "MS 3.5 ÜST", btts: "KG VAR", home15: "EV 1.5 ÜST", away15: "DEP 1.5 ÜST" };
  const rows = oddsForFixture(oddsRow); const out = {};
  for (const [key, market] of Object.entries(map)) {
    const o = rows.filter(x => x.market === market).sort((a,b)=>b.probability-a.probability)[0];
    const form = marketSupport(market, homeForm, awayForm);
    if (o || form != null) {
      const percent = o && form != null ? Math.round(o.probability * 0.55 + form * 0.45) : o ? Math.round(o.probability) : Math.round(form);
      out[key] = { percent, sampleSize: Math.min(homeForm?.sampleSize || 0, awayForm?.sampleSize || 0), source: o ? "Oran + son 5 maç formu" : "Son 5 maç formu; oran bulunamadı" };
    }
  }
  return out;
}

function marketConsistentWithScore(market, scoreObj) {
  const pair = value => {
    const m = String(value || "").match(/(\d+)\s*[-:]\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const ft = pair(scoreObj?.fullTimeScore);
  const htText = String(scoreObj?.halfTimeScore || "");
  const ht = /Canlı skor/i.test(htText) ? null : pair(htText);
  if (market === "KG VAR" && ft && (ft[0] < 1 || ft[1] < 1)) return false;
  if (market === "EV 1.5 ÜST" && ft && ft[0] < 2) return false;
  if (market === "DEP 1.5 ÜST" && ft && ft[1] < 2) return false;
  if (market === "MS 0.5 ÜST" && ft && ft[0] + ft[1] < 1) return false;
  if (market === "MS 1.5 ÜST" && ft && ft[0] + ft[1] < 2) return false;
  if (market === "MS 2.5 ÜST" && ft && ft[0] + ft[1] < 3) return false;
  if (market === "MS 3.5 ÜST" && ft && ft[0] + ft[1] < 4) return false;
  if (market === "İY 0.5 ÜST" && ht && ht[0] + ht[1] < 1) return false;
  if (market === "İY 1.5 ÜST" && ht && ht[0] + ht[1] < 2) return false;
  return true;
}

function chooseSupportedMarket(oddsRow, mode, fixture, forms, stats, prematchOddsRow, excludeMarket = null, preferredMarket = null) {
  const live = mode === "live";
  const total = Number(fixture.homeScore || 0) + Number(fixture.awayScore || 0);
  const minute = Number(fixture.minute || 0);
  // Canlı tercih: 25. dakikadan sonra; 33. dakika sınırında pazar seçimi skorla değişir. 85+ riskli.
  if (live && (minute < 25 || minute > 85)) return null;

  // Dakika + anlık skora göre izin verilen piyasalar (dayanak: kalan süre ve mevcut gol sayısı).
  let allowed;
  if (!live) {
    allowed = ["EV 1.5 ÜST", "DEP 1.5 ÜST", "MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR"];
  } else if (minute >= 25 && minute < 33) {
    // 33. dakikaya kadar: ilk yarıda henüz gol yoksa İY 0.5; gol varsa o pazar zaten gerçekleşmiş sayılır.
    if (total === 0) allowed = ["İY 0.5 ÜST"];
    else if (total === 1) allowed = ["İY 1.5 ÜST"];
    else allowed = ["İY 1.5 ÜST"];
  } else if (minute >= 33 && minute < 45) {
    // 33. dakikadan sonra: 0-0 ise MS 1.5; tek gol varsa İY 1.5 yalnızca ikinci ilk-yarı golü için değerlendirilir.
    if (total === 0) allowed = ["MS 1.5 ÜST"];
    else if (total === 1) allowed = ["İY 1.5 ÜST", "MS 1.5 ÜST", "KG VAR"];
    else allowed = ["MS 2.5 ÜST", "KG VAR"];
  } else if (minute >= 45 && minute < 55) {
    if (total === 0) allowed = ["MS 0.5 ÜST", "MS 1.5 ÜST"];
    else if (total === 1) allowed = ["MS 1.5 ÜST", "KG VAR"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else allowed = ["MS 3.5 ÜST", "KG VAR"];
  } else if (minute >= 55 && minute <= 65) {
    if (total === 0) allowed = ["MS 0.5 ÜST", "MS 1.5 ÜST"];
    else if (total === 1) allowed = ["MS 1.5 ÜST", "KG VAR"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else allowed = ["MS 3.5 ÜST", "KG VAR"];
  } else if (minute >= 66 && minute <= 75) {
    if (total === 0) allowed = ["MS 1.5 ÜST", "MS 2.5 ÜST"];
    else if (total === 1) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR"];
    else allowed = ["MS 3.5 ÜST"];
  } else {
    // 76–85: sadece yüksek baskı + az gol ihtiyacı
    if (total <= 1) allowed = ["MS 1.5 ÜST", "MS 2.5 ÜST"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "MS 3.5 ÜST"];
    else allowed = ["MS 3.5 ÜST"];
  }

  const h = forms.home, a = forms.away;
  const predictedScores = scorePrediction(fixture, h, a, live ? oddsRow : null, prematchOddsRow || (!live ? oddsRow : null));
  const liveMarketRows = oddsForFixture(oddsRow);
  const preMarkets = oddsForFixture(prematchOddsRow || null);
  // Canlı maçta canlı kotasyon önceliklidir; maç önü oranı piyasa hareketini ölçmek
  // ve canlı feed'de eksik kalan marketleri yedeklemek için kullanılır.
  const liveMarketNames = new Set(liveMarketRows.map(x => x.market));
  const mergedMarketRows = live
    ? [
        ...liveMarketRows.map(x => ({ ...x, oddsTiming: "live" })),
        ...preMarkets.filter(x => !liveMarketNames.has(x.market)).map(x => ({ ...x, oddsTiming: "prematch-fallback" }))
      ]
    : liveMarketRows.map(x => ({ ...x, oddsTiming: "prematch" }));
  // Marketi mevcut skor/dakika ve market çizgisi belirler. Tek bir skor tahminine
  // bağlı filtre bazı geçerli canlı marketleri gereksiz yere eliyordu.
  const choices = mergedMarketRows.filter(x => allowed.includes(x.market) && x.market !== excludeMarket);
  const statsM = stats || { available: false, pressure: 0, home: {}, away: {} };
  const favorite = (() => {
    const winners = preMarkets.filter(x => x.market === "MS 1");
    const home = winners.find(x => x.bookmaker && x.market === "MS 1" && x.homeOdd)?.homeOdd;
    const away = winners.find(x => x.bookmaker && x.market === "MS 1" && x.awayOdd)?.awayOdd;
    return home && away ? (home < away ? "home" : "away") : null;
  })();
  const leader = Number(fixture.homeScore || 0) > Number(fixture.awayScore || 0) ? "home"
    : Number(fixture.awayScore || 0) > Number(fixture.homeScore || 0) ? "away" : null;

  // Canlıda biraz daha sıkı eşikler: oran olasılığı + form birlikte doğrulanmalı.
  const minMarketPct = {
    "EV 1.5 ÜST": 48, "DEP 1.5 ÜST": 48, "MS 2.5 ÜST": 50, "MS 3.5 ÜST": 30,
    "KG VAR": 50, "İY 0.5 ÜST": 54, "İY 1.5 ÜST": 34, "MS 0.5 ÜST": 60, "MS 1.5 ÜST": 54
  };
  const minFormPct = {
    "EV 1.5 ÜST": 45, "DEP 1.5 ÜST": 45, "MS 2.5 ÜST": 48, "MS 3.5 ÜST": 34,
    "KG VAR": 48, "İY 0.5 ÜST": 52, "İY 1.5 ÜST": 34, "MS 0.5 ÜST": 54, "MS 1.5 ÜST": 50
  };

  const ranked = choices.map(choice => {
    const formPct = marketSupport(choice.market, h, a);
    let liveBonus = 0;
    let rejectReason = null;
    if (live) {
      if (!statsM.available) return null;

      // Canlı piyasa olasılığı seçim puanında kullanılır; maç önü oranı scorePrediction içinde referans olarak kalır.

      if (choice.market.startsWith("İY ") && minute >= 45) return null;
      if (choice.market.startsWith("İY ")) {
        const currentHalfGoals = Number(fixture.htHomeScore ?? fixture.homeScore ?? 0) + Number(fixture.htAwayScore ?? fixture.awayScore ?? 0);
        const line = Number(choice.market.match(/(\d)[.,](\d)/)?.[1] || 0) + 0.5;
        if (currentHalfGoals >= Math.ceil(line)) return null;
      }
      if (choice.market === "MS 0.5 ÜST" && total >= 1) return null;
      if (choice.market === "MS 1.5 ÜST" && total >= 2) return null;
      if (choice.market === "MS 2.5 ÜST" && total >= 3) return null;
      if (choice.market === "MS 3.5 ÜST" && total >= 4) return null;

      const lineNum = Number(String(choice.market).match(/(\d)[.,](\d)/)?.[0]?.replace(",", ".") || 0);
      const needed = choice.market.startsWith("MS ") ? Math.max(0, Math.ceil(lineNum + 0.01) - total) : 1;

      // Geç dakikada çok gol ihtiyacı + düşük baskı = red.
      if (minute >= 66 && needed > 1 && statsM.pressure < 16) return null;
      if (minute >= 72 && needed > 1 && statsM.pressure < 22) return null;
      if (minute >= 78 && needed >= 1 && statsM.pressure < 20) return null;
      if (minute >= 75 && choice.market === "MS 3.5 ÜST" && (needed > 1 || statsM.pressure < 26)) return null;

      // KG VAR: geride kalan favori takım baskısı şart.
      if (choice.market === "KG VAR") {
        if (total >= 2 && Number(fixture.homeScore || 0) > 0 && Number(fixture.awayScore || 0) > 0) return null; // zaten KG var
        if (leader && favorite && leader !== favorite) {
          const trailing = leader === "home" ? "away" : "home";
          const p = statsM[trailing] || {};
          const trailingPressure = Number(p.shotsOnTarget || 0) * 2.5 + Number(p.totalShots || 0) * 0.45 + Number(p.corners || 0) * 0.8;
          if (trailingPressure < 5.5 || Number(formPct || 0) < 50) return null;
          liveBonus += Math.min(14, trailingPressure * 0.55);
        } else if (!leader) {
          // Beraberlikte her iki tarafın da şut baskısı olmalı.
          const hp = Number(statsM.home?.shotsOnTarget || 0) + Number(statsM.away?.shotsOnTarget || 0);
          if (hp < 2 && statsM.pressure < 8) return null;
        }
      }

      // 0-0 / 1-0 senaryolarında erken-orta canlı: baskı eşiği.
      if (minute >= 55 && minute <= 65 && total === 0 && choice.market === "MS 0.5 ÜST" && statsM.pressure < 5.5) return null;
      if (minute >= 25 && minute < 33 && total === 0 && choice.market === "İY 0.5 ÜST" && statsM.pressure < 4) return null;

      // Genel baskı bonusu (isabetli şut ağırlıklı).
      liveBonus += Math.min(16, statsM.pressure * 0.28);
      // Dakika ilerledikçe üst gol piyasalarına hafif ceza (zaman riski).
      if (/MS [23][.,][05] ÜST/.test(choice.market)) {
        liveBonus -= Math.max(0, (minute - 60) * 0.22);
      }
    }

    if (formPct == null || choice.probability < minMarketPct[choice.market] || formPct < minFormPct[choice.market]) return null;
    const score = choice.probability * 0.52 + formPct * 0.38 + liveBonus
      - (live && choice.market === "MS 3.5 ÜST" ? Math.max(0, minute - 65) * 0.4 : 0);
    return {
      ...choice,
      formPct,
      score,
      statsSummary: live ? statsM : null,
      liveContext: live ? { minute, total, pressure: statsM.pressure, neededGoals: choice.market.startsWith("MS ") ? Math.max(0, Math.ceil(Number(String(choice.market).match(/(\d)[.,](\d)/)?.[0]?.replace(",", ".") || 0) + 0.01) - total) : null } : null
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score);

  if (preferredMarket) {
    const preferred = ranked.find(x => x.market === preferredMarket);
    if (preferred) return preferred;
  }
  return ranked[0] || null;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, reason: "TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID tanımlı değil." };
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`);
  return { sent: true };
}

function couponMessage(coupon) {
  const heading = coupon.type === "surprise" ? "🎲 WINSCOPE MAÇ ÖNÜ SÜRPRİZ 10 MAÇ" :
    coupon.type === "live" ? "⚡ WINSCOPE CANLI EN GÜVENİLİR TEK TERCİH" :
    "🎯 WINSCOPE MAÇ ÖNÜ KUPONU";
  const lines = [heading, `Tarih: ${coupon.date || "Bugün"}`, ""];
  coupon.picks.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.home} - ${p.away}`);
    lines.push(`Tercih: ${p.market}`);
    lines.push(`Lig: ${p.league}`);
    if (coupon.type === "live" || p.isLive) {
      if (p.minute != null) lines.push(`Dakika: ${p.minute}' | Skor: ${p.currentScore || "—"}`);
      if (p.source) lines.push(`Kaynak: ${p.source}`);
      if (p.oddsBasis) lines.push(`Oran dayanağı: ${p.oddsBasis}`);
      if (Array.isArray(p.statsSummary) && p.statsSummary.length) {
        lines.push(`Canlı istatistik: ${p.statsSummary.join(" · ")}`);
      }
      if (p.marketProbability != null) lines.push(`Piyasa olasılığı: %${Number(p.marketProbability).toFixed(1)}`);
      if (p.formSupport != null) lines.push(`Form desteği: %${Number(p.formSupport).toFixed(0)}`);
    }
    lines.push("");
  });
  if (coupon.type === "live") {
    const usedLiveOdds = coupon.picks.some(p => p.oddsTiming === "live" || /canlı oran/i.test(String(p.oddsBasis || "")));
    lines.push(usedLiveOdds
      ? "Dayanak: canlı oran mevcutsa kullanıldı ve maç önü oranıyla karşılaştırıldı; son 5 maç formu + canlı şut/korner baskısı + dakika/skor penceresi de değerlendirildi."
      : "Dayanak: bu maçta kullanılabilir canlı oran alınamadı; maç önü oranı yedek olarak kullanıldı. Son 5 maç formu + canlı şut/korner baskısı + dakika/skor penceresi değerlendirildi.");
  }
  return lines.join("\n");
}


async function getOddsForFixture(fixtureId, date) {
  // Prefer date-level odds for the bulletin, then fall back to fixture-specific odds.
  let row = null;
  if (date) {
    try {
      const byDate = await cachedProviderRequest(`odds-date:${date}`, `/odds?date=${encodeURIComponent(date)}`, 90000);
      row = (byDate.response || []).find(x => Number(x.fixture?.id) === Number(fixtureId)) || null;
    } catch (e) {
      console.warn("Date odds lookup failed:", e.message);
    }
  }
  if (!row) {
    const byFixture = await cachedProviderRequest(`odds-fixture:${fixtureId}`, `/odds?fixture=${encodeURIComponent(fixtureId)}`, 90000);
    row = (byFixture.response || []).find(x => Number(x.fixture?.id) === Number(fixtureId)) || byFixture.response?.[0] || null;
  }
  return row;
}

function rankSingleMatchChoices(choices, mode = "prematch") {
  const allowed = choices.filter(x => x.odd >= 1.15 && x.odd <= 2.10);
  return allowed.sort((a, b) => {
    // Conservative odds first; tie-break with market hierarchy, not invented percentages.
    return Math.abs(a.odd - 1.35) - Math.abs(b.odd - 1.35) || a.rank - b.rank;
  });
}


async function sendCouponAutomatically(coupon, chosen) {
  const signature = `${coupon.date}|${coupon.type}|${chosen.map(p => `${p.fixtureId}:${p.market}`).sort().join(",")}`;
  const now = Date.now();
  for (const [key, at] of telegramDeliveryCache) if (now - at > 24 * 60 * 60 * 1000) telegramDeliveryCache.delete(key);
  if (telegramDeliveryCache.has(signature)) {
    return { sent: true, duplicateSuppressed: true, message: "Bu kupon daha önce Telegram'a gönderildi; tekrar gönderilmedi." };
  }
  try {
    const result = await sendTelegram(couponMessage(coupon));
    if (result.sent) {
      telegramDeliveryCache.set(signature, now);
      if (telegramDeliveryCache.size > 500) telegramDeliveryCache.delete(telegramDeliveryCache.keys().next().value);
      if (coupon.autoGenerated) {
        for (const p of (coupon.picks || [])) {
          if (p.fixtureId) autoSentFixtureKeys.add(`${coupon.type}|${coupon.date}|${Number(p.fixtureId)}`);
        }
      }
      const sourceLabel = coupon.type === "live" ? "Canlı en güvenilir tek tercih" : coupon.type === "surprise" ? "Maç önü sürpriz kuponu" : "Günün kuponu";
      for (const p of (coupon.picks || [])) {
        const fixtureId = Number(p.fixtureId);
        if (!fixtureId) continue;
        const score = String(p.currentScore || "0-0");
        goalTrackedFixtures.set(fixtureId, { home: p.home, away: p.away, league: p.league, sourceLabel, baselineScore: score });
        // Kupon üretilirken bilinen skor başlangıç kabul edilir.
        if (!goalScoreCache.has(fixtureId)) goalScoreCache.set(fixtureId, score);
      }
    }
    return result;
  } catch (error) {
    console.error(`[Telegram] Otomatik kupon gönderimi başarısız (${coupon.type}):`, error.message);
    return { sent: false, error: error.message };
  }
}

function automaticLeaguePriority(match) {
  const league = String(match.league || "").toLowerCase();
  const country = String(match.country || "").toLowerCase();
  if (league.includes("premier league") || league === "la liga" || league.includes("serie a") || league.includes("bundesliga") || league.includes("ligue 1")) return 1;
  if (league.includes("eredivisie") || league.includes("primeira liga") || league.includes("championship") || league.includes("champions league") || league.includes("europa league") || league.includes("conference league")) return 2;
  if (["england", "spain", "italy", "germany", "france", "portugal", "netherlands"].includes(country)) return 3;
  return 4;
}

async function createCouponByMode(date, mode = "prematch", options = {}) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Geçerli bir maç tarihi seç.");
  const isLiveMode = mode === "live";
  const fixturePath = isLiveMode ? "/fixtures?live=all" : `/fixtures?date=${encodeURIComponent(date)}&timezone=Europe/Istanbul`;
  const fixtureKey = isLiveMode ? "liveListForCoupon" : `fixtures:${date}`;
  const fixturePayload = await cachedProviderRequest(fixtureKey, fixturePath, isLiveMode ? 15000 : 60000);
  const allFixtures = (fixturePayload.response || []).map(normalizeProviderMatch)
    .filter(m => m.id && (isLiveMode ? m.status === "LIVE" && Number(m.minute || 0) >= 25 && Number(m.minute || 0) <= 80 : m.status === "NS"));
  // Büyük ligleri önceliklendir; aynı öncelikte erken başlayacak maçları öne al.
  allFixtures.sort((a, b) => automaticLeaguePriority(a) - automaticLeaguePriority(b) ||
    String(a.fixtureDate || "").localeCompare(String(b.fixtureDate || "")));
  // Otomatik tarama ilk birkaç maçla sınırlı kalmasın; API istek kuyruğu hız sınırını korur.
  const fixtures = allFixtures.slice(0, isLiveMode ? (options.automatic ? 12 : 15) : (options.automatic ? 20 : 35));
  if (!fixtures.length) return { draftId:`coupon-${Date.now()}`, date, type:mode, status:"NO_MATCHES", picks:[], message:isLiveMode ? "Şu anda uygun dakika aralığında canlı maç bulunamadı." : "Seçilen tarihte başlamamış maç bulunamadı." };

  const dateOdds = new Map();
  if (!isLiveMode) {
    try {
      const payload = await cachedProviderRequest(`odds-date:${date}`, `/odds?date=${encodeURIComponent(date)}`, 90000);
      for (const row of (payload.response || [])) dateOdds.set(Number(row.fixture?.id), row);
    } catch (e) { console.warn(`[Coupon] date odds: ${e.message}`); }
  }
  const candidates = [], errors = [];
  const rejected = { noOdds: 0, noIds: 0, noForm: 0, noStats: 0, noMarket: 0, noSignal: 0, apiErrors: 0, duplicate: 0 };
  let fixturesToAnalyze = fixtures;
  if (!isLiveMode && dateOdds.size) {
    const withBulkOdds = fixtures.filter(f => dateOdds.has(f.id));
    const withoutBulkOdds = fixtures.filter(f => !dateOdds.has(f.id));
    // Önce toplu oran cevabındaki maçları kullan; gerektiğinde sınırlı sayıda yedek maça bak.
    fixturesToAnalyze = [...withBulkOdds.slice(0, 25), ...withoutBulkOdds.slice(0, 8)];
  } else if (!isLiveMode) {
    fixturesToAnalyze = fixtures.slice(0, options.automatic ? 20 : 12);
  }
  for (const fixture of fixturesToAnalyze) {
    try {
      let marketOddsRow = null, prematchOddsRow = null, oddsBasis = "";
      if (isLiveMode) {
        const [livePayload, prePayload, statsPayload, homeForm, awayForm] = await Promise.all([
          cachedProviderRequest(`odds-live:${fixture.id}`, `/odds/live?fixture=${fixture.id}`, 15000).catch(()=>({response:[]})),
          cachedProviderRequest(`odds-fixture:${fixture.id}`, `/odds?fixture=${fixture.id}`, 90000).catch(()=>({response:[]})),
          cachedProviderRequest(`stats:${fixture.id}`, `/fixtures/statistics?fixture=${fixture.id}`, 15000),
          fetchTeamRecentForm(fixture.homeId, fixture.id),
          fetchTeamRecentForm(fixture.awayId, fixture.id)
        ]);
        prematchOddsRow = (prePayload.response || []).find(row=>Number(row.fixture?.id)===fixture.id) || prePayload.response?.[0] || null;
        marketOddsRow = (livePayload.response || []).find(row=>Number(row.fixture?.id)===fixture.id) || null;
        const liveMarketStatus = marketOddsRow?.status || {};
        if (liveMarketStatus.blocked || liveMarketStatus.stopped || liveMarketStatus.finished) continue;
        if (!marketOddsRow) marketOddsRow = prematchOddsRow;
        const statsRows = statsPayload.response || [];
        const stats = liveStatsMetrics(statsRows, fixture);
        if (!marketOddsRow) { rejected.noOdds++; continue; }
        if (!stats.available) { rejected.noStats++; continue; }
        if (!homeForm.available || !awayForm.available) { rejected.noForm++; continue; }
        const chosen = chooseSupportedMarket(marketOddsRow, mode, fixture, {home:homeForm,away:awayForm}, stats, prematchOddsRow);
        if (!chosen) { rejected.noSignal++; continue; }
        const timingLabel = chosen.oddsTiming === "live" ? "canlı oran" : "maç önü yedek";
        oddsBasis = `${timingLabel} · ${chosen.bookmaker}; maç önü referansı: ${prematchOddsRow ? "var" : "yok"}`;
        candidates.push({
          fixtureId: fixture.id, league: fixture.league, country: fixture.country,
          home: fixture.home, away: fixture.away, fixtureDate: fixture.fixtureDate,
          market: chosen.market, source: chosen.bookmaker, oddsTiming: chosen.oddsTiming,
          internalOdd: chosen.odd, marketProbability: chosen.probability,
          formSupport: chosen.formPct, score: chosen.score,
          minute: fixture.minute, currentScore: `${fixture.homeScore}-${fixture.awayScore}`,
          isLive: true, oddsBasis,
          statsSummary: [
            `İsabetli şut: ${stats.shotsOnTarget}`,
            `Toplam şut: ${stats.totalShots}`,
            `Korner: ${stats.corners}`,
            `Baskı skoru: ${Number(stats.pressure || 0).toFixed(1)}`
          ]
        });
      } else {
        marketOddsRow = dateOdds.get(fixture.id) || null;
        if (!marketOddsRow) {
          const payload = await cachedProviderRequest(`odds-fixture:${fixture.id}`, `/odds?fixture=${fixture.id}`, 90000);
          marketOddsRow = (payload.response || []).find(row=>Number(row.fixture?.id)===fixture.id) || null;
        }
        if (!marketOddsRow) { rejected.noOdds++; continue; }
        if (!fixture.homeId || !fixture.awayId) { rejected.noIds++; continue; }
        const [homeForm, awayForm] = await Promise.all([fetchTeamRecentForm(fixture.homeId,fixture.id),fetchTeamRecentForm(fixture.awayId,fixture.id)]);
        if (!homeForm.available || !awayForm.available) { rejected.noForm++; continue; }
        const chosen = chooseSupportedMarket(marketOddsRow, mode, fixture, {home:homeForm,away:awayForm}, null, marketOddsRow);
        if (!chosen) { rejected.noSignal++; continue; }
        oddsBasis = "API-Football maç önü son mevcut oran kaydı; resmî kapanış olduğu garanti edilemez";
        candidates.push({fixtureId:fixture.id,league:fixture.league,country:fixture.country,home:fixture.home,away:fixture.away,
          fixtureDate:fixture.fixtureDate,market:chosen.market,source:chosen.bookmaker,internalOdd:chosen.odd,marketProbability:chosen.probability,
          formSupport:chosen.formPct,score:chosen.score,minute:null,currentScore:"0-0",isLive:false,oddsBasis,statsSummary:null});
      }
    } catch(e) {
      rejected.apiErrors++;
      const message = /istek sınırına ulaşıldı/i.test(e.message) ? "API-Football istek sınırı; kuyruk beklemesi devrede" : e.message;
      errors.push(`${fixture.home} - ${fixture.away}: ${message}`);
      if (/istek sınırına ulaşıldı/i.test(e.message)) break;
    }
  }
  // Otomatik gönderimlerde aynı gün daha önce gönderilmiş maçları yeniden seçme.
  const availableCandidates = options.automatic
    ? candidates.filter(p => !autoSentFixtureKeys.has(`${mode}|${date}|${Number(p.fixtureId)}`))
    : candidates;
  rejected.duplicate = candidates.length - availableCandidates.length;
  console.log(`[COUPON SCAN ${mode.toUpperCase()}] date=${date} live=${isLiveMode} fixtures=${allFixtures.length} prioritized=${fixtures.length} analyzed=${fixturesToAnalyze.length} candidates=${candidates.length} available=${availableCandidates.length} rejected=${JSON.stringify(rejected)} errors=${errors.length}`);
  availableCandidates.sort((a,b)=>b.score-a.score || b.formSupport-a.formSupport || a.internalOdd-b.internalOdd);
  const count = mode === "surprise" ? 10 : mode === "prematch" ? 2 : 1;
  const chosen = availableCandidates.slice(0,count);
  if (!chosen.length || (mode === "prematch" && chosen.length < 2) || (mode === "surprise" && chosen.length < 10)) {
    const needed = mode === "surprise" ? 10 : mode === "prematch" ? 2 : 1;
    return {draftId:`coupon-${Date.now()}`,date,type:mode,status:"NO_MATCHES",picks:[],
      message:`Maç önü oranı + son 5 maç formu${isLiveMode ? " + canlı istatistik" : ""} eşiklerini geçen yeterli maç yok (gereken: ${needed}). Kupon zorlanmadı.`,
      detail:`Tarama: ${fixturesToAnalyze.length}; aday: ${candidates.length}; elenme: oran=${rejected.noOdds}, form=${rejected.noForm}, canlı-istatistik=${rejected.noStats}, piyasa-sinyali=${rejected.noSignal}, API-hatası=${rejected.apiErrors}, tekrar=${rejected.duplicate}. ${errors.slice(0,2).join(" | ")}`};
  }
  // internalOdd / score iç skorlama; canlı kupon Telegram'da olasılık + form + dk/skor gösterilsin.
  const publicPicks = chosen.map(({ internalOdd, score, ...p }) => p);
  const draftId = `coupon-${Date.now()}`;
  const coupon = {draftId,date,type:mode,isLive:isLiveMode,status:"READY",picks:publicPicks,autoGenerated:Boolean(options.automatic),
    message:mode==="live" ? (chosen.some(p => p.oddsTiming === "live")
      ? "Tek canlı tercih: kullanılabilir canlı oran + maç önü oranına göre piyasa hareketi + dakika/skor + son 5 form + canlı şut/korner baskısı değerlendirildi."
      : "Tek canlı tercih: kullanılabilir canlı oran bulunamadı; maç önü oranı yedek olarak kullanıldı. Dakika/skor + son 5 form + canlı şut/korner baskısı değerlendirildi.") :
      mode==="surprise" ? "10 maçlık sürpriz kupon: her maç oran ve son 5 gerçek skor formu ile doğrulandı." :
      "Maç önü kuponu: en az iki maç, maç önü son mevcut oran ve son 5 gerçek skor formu birlikte değerlendirildi."};
  archives.coupons.unshift({date,type:mode,picks:publicPicks,createdAt:new Date().toISOString()});
  archives.coupons=archives.coupons.slice(0,50);
  // Onay butonu olmadan, kupon başarıyla üretildiğinde Telegram'a otomatik gönder.
  coupon.telegram = await sendCouponAutomatically(coupon, chosen);
  return coupon;
}

app.get("/api/telegram/status", async (_req, res) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(503).json({
      ok: false,
      configured: false,
      botActive: false,
      chatConfigured: Boolean(TELEGRAM_CHAT_ID),
      message: "Render Environment içinde TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID kontrol edilmeli."
    });
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      return res.status(502).json({
        ok: false, configured: true, botActive: false,
        message: result.description || `Telegram API HTTP ${response.status}`
      });
    }
    return res.json({
      ok: true, configured: true, botActive: true,
      botUsername: result.result?.username || null,
      chatConfigured: true,
      message: "Bot token geçerli ve Telegram botu aktif. Chat ID'ye mesaj gönderme yetkisi ayrıca test edilmelidir."
    });
  } catch (e) {
    return res.status(502).json({
      ok: false, configured: true, botActive: false,
      message: `Telegram bağlantı testi başarısız: ${e.message}`
    });
  }
});

app.get("/api/health", (_req, res) => res.json({
  ok: true, apiKeyConfigured: Boolean(API_KEY),
  telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
}));

app.get("/api/match/:id/analyze", async (req, res) => {
  try {
    const payload = await cachedProviderRequest(`fixture:${req.params.id}`, `/fixtures?id=${encodeURIComponent(req.params.id)}`, 15000);
    const row = payload.response?.[0];
    if (!row) return res.status(404).json({error:"Maç verisi bulunamadı."});
    const match = normalizeProviderMatch(row);
    const isLive = match.status === "LIVE";
    const [prematchOddsPayload, liveOddsPayload, statsPayload, homeForm, awayForm] = await Promise.all([
      cachedProviderRequest(`odds-fixture:${match.id}`, `/odds?fixture=${match.id}`, 90000).catch(()=>({response:[]})),
      isLive ? cachedProviderRequest(`odds-live:${match.id}`, `/odds/live?fixture=${match.id}`, 15000).catch(()=>({response:[]})) : Promise.resolve({response:[]}),
      isLive ? cachedProviderRequest(`stats:${match.id}`, `/fixtures/statistics?fixture=${match.id}`, 15000).catch(()=>({response:[]})) : Promise.resolve({response:[]}),
      fetchTeamRecentForm(match.homeId,match.id), fetchTeamRecentForm(match.awayId,match.id)
    ]);
    const prematchRow = (prematchOddsPayload.response||[]).find(x=>Number(x.fixture?.id)===match.id)||prematchOddsPayload.response?.[0]||null;
    const liveRow = (liveOddsPayload.response||[]).find(x=>Number(x.fixture?.id)===match.id)||null;
    const liveMarketStatus = liveRow?.status || {};
    const usableLiveRow = liveMarketStatus.blocked || liveMarketStatus.stopped || liveMarketStatus.finished ? null : liveRow;
    const stats = liveStatsMetrics(statsPayload.response||[],match);
    const oddsRow = isLive ? (usableLiveRow || prematchRow) : prematchRow;
    const earlyLive = isLive && Number(match.minute || 0) < 25;
    // 25. dakikadan önce canlı tercih üretme; ancak maç önü analizini ekranda koru.
    const prematchChoice = earlyLive && prematchRow && homeForm.available && awayForm.available
      ? chooseSupportedMarket(prematchRow,"prematch",match,{home:homeForm,away:awayForm},null,prematchRow)
      : null;
    const chosen = oddsRow && homeForm.available && awayForm.available
      ? chooseSupportedMarket(oddsRow,isLive?"live":"prematch",match,{home:homeForm,away:awayForm},isLive?stats:null,prematchRow)
      : null;
    const activeChoice = chosen || prematchChoice;
    const activeChoiceMode = chosen ? (isLive ? "live" : "prematch") : "prematch";
    const total=Number(match.homeScore||0)+Number(match.awayScore||0);
    const htGoals = Number(match.htHomeScore||0)+Number(match.htAwayScore||0);
    const htMarketAlreadyHit = match.minute < 45 ? total >= 1 : htGoals >= 1;
    const scores = scorePrediction(match,homeForm,awayForm,isLive && usableLiveRow ? usableLiveRow : null,prematchRow);
    const predictedFt = String(scores.fullTimeScore || "").match(/(\d+)\s*[-:]\s*(\d+)/);
    const scoreSuggestsBtts = Boolean(predictedFt && Number(predictedFt[1]) > 0 && Number(predictedFt[2]) > 0);
    const alternativeChoice = activeChoice && homeForm.available && awayForm.available
      ? chooseSupportedMarket(activeChoiceMode === "prematch" ? prematchRow : oddsRow,activeChoiceMode,match,{home:homeForm,away:awayForm},activeChoiceMode === "live" ? stats : null,prematchRow,activeChoice.market,scoreSuggestsBtts?"KG VAR":null)
      : null;
    res.json({
      fixtureId:match.id,matchStatus:match.status,
      halfTimeScore:match.status==="FT"?`${match.htHomeScore??"?"}-${match.htAwayScore??"?"}`:isLive&&match.minute<45&&total>0?`Canlı skor: ${match.homeScore}-${match.awayScore}`:scores.halfTimeScore,
      fullTimeScore:match.status==="FT"?`${match.homeScore}-${match.awayScore}`:scores.fullTimeScore,
      scoreBasis:scores.scoreBasis || "Skor tahmininde kullanılan kaynak bilgisi yok",
      mainPick:chosen?.market || (earlyLive && prematchChoice ? `${prematchChoice.market} (maç önü sinyali)` : earlyLive ? "Maç önü piyasa sinyali bulunamadı; canlı tercih 25. dakikadan sonra değerlendirilecek" : "Doğrulanabilir piyasa verisi bulunamadı"),
      alternative:alternativeChoice?.market || (earlyLive ? "Canlı tercih 25. dakikadan sonra değerlendirilecek" : "Desteklenen ikinci tercih bulunamadı"),
      surprise:chosen ? "Sürpriz yalnızca ayrı piyasa sinyali desteklerse değerlendirilir" : (earlyLive ? "Canlı sürpriz tercihi 25. dakikadan sonra değerlendirilecek" : "Sürpriz için doğrulanabilir piyasa verisi yok"),
      marketPercentages:analysisPercentages(isLive && usableLiveRow ? usableLiveRow : prematchRow,homeForm,awayForm),
      note:chosen?`${chosen.bookmaker}; ${isLive && chosen.oddsTiming === "live" ? "canlı oran, maç önü oranına göre piyasa hareketi ve " : "maç önü piyasa olasılığı ve "}son 5 maç formu birlikte değerlendirildi${isLive?`; canlı baskı: ${stats.shotsOnTarget} isabetli şut, ${stats.totalShots} toplam şut, ${stats.corners} korner`:""}.`:
        (earlyLive ? (prematchChoice ? `Maç önü piyasa sinyali ${prematchChoice.market} olarak korundu. Bu, canlı tercih değildir; canlı tercih 25. dakikadan sonra maç önü oranı + canlı istatistik + form ile hesaplanacak.` : "Maç önü tercih için yeterli doğrulanabilir piyasa/form verisi yok. Canlı tercih 25. dakikadan sonra değerlendirilecek.") : `Bu maç için doğrulanabilir maç önü oranı + son 5 maç formu${isLive?" + canlı istatistik":""} birlikte bulunamadı; tahmin uydurulmadı.`),
      oddsBasis:isLive?(usableLiveRow?"Canlı oran + maç önü referansı; oran değerleri arayüzde gösterilmez":"Canlı oran bulunamadı/kapalı; maç önü oranı yedek kullanıldı"):"API-Football maç önü son mevcut oran kaydı; resmî kapanış garantisi yok",
      htMarketAlreadyHit
    });
  } catch(e) { res.status(502).json({error:"Analiz üretilemedi.",detail:e.message}); }
});

app.get("/api/live", async (_req, res) => {
  try {
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 20000);
    const matches = (payload.response || []).map(normalizeProviderMatch);
    res.json({ source: "API-Football", results: matches.length, matches, fetchedAt: new Date().toISOString() });
  } catch (e) { res.status(502).json({ error: "Canlı maçlar alınamadı", detail: e.message, matches: [] }); }
});

app.get("/api/fixtures", async (req, res) => {
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Tarih YYYY-MM-DD biçiminde olmalı." });
  try {
    const payload = await cachedProviderRequest(`fixtures:${date}`, `/fixtures?date=${date}&timezone=Europe/Istanbul`, 60000);
    const matches = (payload.response || []).map(normalizeProviderMatch);
    res.json({ source: "API-Football", results: matches.length, matches });
  } catch (e) { res.status(502).json({ error: "Bülten alınamadı", detail: e.message, matches: [] }); }
});


app.get("/api/coupon/daily", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || ""), "prematch")); }
  catch (e) { res.status(502).json({ status: "ERROR", picks: [], error: "Maç önü kuponu oluşturulamadı.", detail: e.message }); }
});
app.get("/api/coupon/best", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || ""), "prematch")); }
  catch (e) { res.status(502).json({ status: "ERROR", picks: [], error: "Maç önü kuponu oluşturulamadı.", detail: e.message }); }
});
app.get("/api/coupon/surprise", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || ""), "surprise")); }
  catch (e) { res.status(502).json({ status: "ERROR", type: "surprise", picks: [], error: "10 maçlık sürpriz kupon oluşturulamadı.", detail: e.message }); }
});
app.get("/api/coupon/live-best", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || new Date().toISOString().slice(0,10)), "live")); }
  catch (e) { res.status(502).json({ status: "ERROR", type: "live", picks: [], error: "Canlı tek tercih oluşturulamadı.", detail: e.message }); }
});

app.post("/api/analyses/approve", (req, res) => {
  const body = req.body || {};
  if (!body.fixtureId || !body.home || !body.away) return res.status(400).json({ success: false, error: "Maç bilgileri eksik." });
  archives.analyses.unshift({
    fixture_id: Number(body.fixtureId), home_team: String(body.home), away_team: String(body.away),
    analysis: body.analysis || {}, created_at: new Date().toISOString()
  });
  archives.analyses = archives.analyses.slice(0, 100);
  res.json({ success: true });
});

app.get("/api/archives", (_req, res) => res.json({ analyses: archives.analyses, coupons: archives.coupons }));

// Canlı Tercih Sonuç Takibi arayüzünün beklediği JSON endpoint'i.
app.get("/api/live-predictions/summary", async (_req, res) => {
  try {
    // Sonucu belli olmuş maçları API-Football'dan kontrol et; geçici API hataları kaydı bozmaz.
    for (const record of livePredictionRecords.values()) {
      if (record.status !== "pending" || !record.fixtureId) continue;
      try {
        const payload = await cachedProviderRequest(`prediction-result:${record.fixtureId}`, `/fixtures?id=${record.fixtureId}`, 60000);
        const raw = payload.response?.[0];
        if (!raw) continue;
        const match = normalizeProviderMatch(raw);
        if (match.status !== "FT") continue;
        const h = Number(match.homeScore || 0), a = Number(match.awayScore || 0);
        const ht = [match.htHomeScore, match.htAwayScore];
        const total = h + a;
        let won = null;
        if (record.market === "KG VAR") won = h >= 1 && a >= 1;
        else if (record.market === "EV 1.5 ÜST") won = h >= 2;
        else if (record.market === "DEP 1.5 ÜST") won = a >= 2;
        else if (record.market === "MS 0.5 ÜST") won = total >= 1;
        else if (record.market === "MS 1.5 ÜST") won = total >= 2;
        else if (record.market === "MS 2.5 ÜST") won = total >= 3;
        else if (record.market === "MS 3.5 ÜST") won = total >= 4;
        else if (record.market === "İY 0.5 ÜST" && ht.every(v => v != null)) won = Number(ht[0]) + Number(ht[1]) >= 1;
        else if (record.market === "İY 1.5 ÜST" && ht.every(v => v != null)) won = Number(ht[0]) + Number(ht[1]) >= 2;
        if (won !== null) {
          record.status = won ? "won" : "lost";
          record.actualScore = `${h}-${a}`;
          record.finishedAt = new Date().toISOString();
        }
      } catch (error) {
        console.warn(`[PREDICTION RESULT] ${record.fixtureId}: ${error.message}`);
      }
    }
    const results = [...livePredictionRecords.values()].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const won = results.filter(p => p.status === "won").length;
    const lost = results.filter(p => p.status === "lost").length;
    const pending = results.filter(p => p.status === "pending").length;
    const settled = won + lost;
    res.json({ total: results.length, pending, won, lost,
      winRate: settled ? Math.round(won / settled * 1000) / 10 : null,
      lossRate: settled ? Math.round(lost / settled * 1000) / 10 : null,
      persistentStorage: false, results: results.slice(0, 100) });
  } catch (error) {
    res.status(500).json({ error: `Canlı tercih sonuçları okunamadı: ${error.message}` });
  }
});

app.get("/api/match/:id/stats", async (req, res) => {
  try {
    const payload = await cachedProviderRequest(`stats:${req.params.id}`, `/fixtures/statistics?fixture=${encodeURIComponent(req.params.id)}`, 30000);
    res.json({ success: true, stats: payload.response || [] });
  } catch (e) { res.status(502).json({ success: false, error: "İstatistik alınamadı.", detail: e.message, stats: [] }); }
});

// Otomatik Telegram akışı: canlı tek tercih açılışta ve her 20 dakikada;
// günün maç önü kuponu açılışta ve ardından 2 saatte bir. Buton gerekmez.
function turkeyDateString() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function runAutomaticLivePick() {
  if (autoLiveTaskInFlight) return;
  autoLiveTaskInFlight = true;
  try {
    const date = turkeyDateString();
    const result = await createCouponByMode(date, "live", { automatic: true });
    if (result.status === "READY" && result.telegram?.sent) {
      const p = result.picks?.[0];
      if (p?.fixtureId && p?.market) {
        const key = `${Number(p.fixtureId)}:${p.market}:${p.minute ?? ""}:${p.currentScore ?? ""}`;
        if (!livePredictionRecords.has(key)) livePredictionRecords.set(key, {
          fixtureId: Number(p.fixtureId), home: p.home, away: p.away, league: p.league,
          market: p.market, scoreAtSignal: p.currentScore || "0-0", minute: p.minute ?? null,
          status: "pending", actualScore: null, createdAt: new Date().toISOString()
        });
      }
      console.log(`[AUTO LIVE] Telegram'a tek canlı tercih gönderildi: ${p?.home} - ${p?.away}`);
    } else {
      console.log(`[AUTO LIVE] Gönderilecek uygun tek tercih yok veya gönderim başarısız: ${result.message || result.telegram?.reason || result.telegram?.error || result.status}`);
    }
  } catch (error) {
    console.error(`[AUTO LIVE ERROR] ${error.message}`);
  } finally {
    autoLiveTaskInFlight = false;
  }
}

async function runAutomaticDailyCoupon() {
  if (autoPrematchTaskInFlight) return;
  autoPrematchTaskInFlight = true;
  try {
    const date = turkeyDateString();
    const result = await createCouponByMode(date, "prematch", { automatic: true });
    if (result.status === "READY" && result.telegram?.sent) {
      console.log(`[AUTO DAILY] Telegram'a günün kuponu gönderildi: ${result.picks?.length || 0} maç`);
    } else {
      console.log(`[AUTO DAILY] Yeni ve uygun iki maç bulunamadı veya gönderim başarısız: ${result.message || result.telegram?.reason || result.telegram?.error || result.status}`);
    }
  } catch (error) {
    console.error(`[AUTO DAILY ERROR] ${error.message}`);
  } finally {
    autoPrematchTaskInFlight = false;
  }
}

setTimeout(() => { void runAutomaticLivePick(); void runAutomaticDailyCoupon(); }, 20000);
setInterval(() => { void runAutomaticLivePick(); }, 90 * 1000);
setInterval(() => { void runAutomaticDailyCoupon(); }, 2 * 60 * 60 * 1000);

// Her 60 saniyede bir Telegram'a gönderilmiş kupon maçlarının skor değişimini kontrol et.
// Böylece gol alarmı yalnızca kupon mesajı atmakla kalmaz, maçtaki skor değişimini de bildirir.
setInterval(async () => {
  if (goalScanInFlight || goalTrackedFixtures.size === 0) return;
  goalScanInFlight = true;
  try {
    const payload = await cachedProviderRequest("goalAlertLiveList", "/fixtures?live=all", 15000);
    const liveMatches = (payload.response || []).map(normalizeProviderMatch);
    const liveById = new Map(liveMatches.map(m => [Number(m.id), m]));
    for (const [fixtureId, tracked] of goalTrackedFixtures.entries()) {
      const match = liveById.get(fixtureId);
      if (!match || match.status !== "LIVE") continue;
      const score = `${match.homeScore}-${match.awayScore}`;
      const previous = goalScoreCache.get(fixtureId) ?? tracked.baselineScore ?? score;
      if (score === previous) continue;
      const message = `⚽ WINSCOPE GOOOOOL!\n🏆 ${match.league || tracked.league || "Lig"}\n⚽ ${match.home || tracked.home} - ${match.away || tracked.away}\n📣 Skor değişti: ${previous} → ${score}\n⏱️ Dakika: ${match.minute ?? "?"}'\n🎯 Takip nedeni: ${tracked.sourceLabel}`;
      try {
        const sent = await sendTelegram(message);
        if (sent.sent) {
          goalScoreCache.set(fixtureId, score);
          tracked.baselineScore = score;
          console.log(`[GOOOOL Alert OK] ${fixtureId} ${previous} -> ${score}`);
        }
      } catch (error) {
        console.error(`[GOOOOL Alert Error] ${fixtureId}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`[GOOOOL Scan Error] ${error.message}`);
  } finally {
    goalScanInFlight = false;
  }
}, 60_000);

app.listen(PORT, () => console.log(`WinScope server running on port ${PORT}`));
