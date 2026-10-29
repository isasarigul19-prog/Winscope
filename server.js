import express from "express";
import pg from "pg";
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
const EMBEDDED_INDEX_HTML = Buffer.from("PCFkb2N0eXBlIGh0bWw+PGh0bWwgbGFuZz0idHIiPjxoZWFkPjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij48bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLGluaXRpYWwtc2NhbGU9MSI+PHRpdGxlPldpblNjb3BlIExpdmU8L3RpdGxlPjxzdHlsZT4KOnJvb3R7LS1iZzojMDQxOTFlOy0tcDojMDgyNzJkOy0tcDI6IzBjMzQzYjstLWxpbmU6IzE1NTA1YTstLXQ6I2YxZmJmYzstLW06IzliYjliZjstLXBpbms6I2ZmMmY2MzstLWdyZWVuOiM0MmU2YTA7LS1hbWJlcjojZmZkMDRhOy0tZ3JheTojN2Y5ZGEzfSp7Ym94LXNpemluZzpib3JkZXItYm94fWJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTU1ZGVnLCMwMzE0MTksIzA3MzAzOCA2NSUsIzA0MTkxZSk7Y29sb3I6dmFyKC0tdCk7Zm9udDoxNHB4IHN5c3RlbS11aSxzYW5zLXNlcmlmfWhlYWRlcntwYWRkaW5nOjE2cHg7bWF4LXdpZHRoOjEwNTBweDttYXJnaW46YXV0bztkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tbGluZSl9LmxvZ297Zm9udC13ZWlnaHQ6OTUwO2xldHRlci1zcGFjaW5nOi4wOGVtO2ZvbnQtc2l6ZToyNXB4fS5sb2dvIHNwYW57Zm9udC1zaXplOjEzcHg7Y29sb3I6dmFyKC0tcGluayk7bWFyZ2luLWxlZnQ6NHB4O2ZvbnQtd2VpZ2h0OjcwMH0uc21hbGwsLnN1Yntjb2xvcjp2YXIoLS1tKTtmb250LXNpemU6MTJweDtsaW5lLWhlaWdodDoxLjQ1fW1haW57bWF4LXdpZHRoOjEwNTBweDttYXJnaW46YXV0bztwYWRkaW5nOjEycHh9LnRvb2xiYXIsLmFjdGlvbnN7ZGlzcGxheTpmbGV4O2dhcDo4cHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZsZXgtd3JhcDp3cmFwO21hcmdpbjoxMHB4IDB9YnV0dG9uLHNlbGVjdCxpbnB1dHtmb250OmluaGVyaXQ7Y29sb3I6dmFyKC0tdCk7YmFja2dyb3VuZDp2YXIoLS1wMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjExcHg7cGFkZGluZzoxMHB4IDEycHh9YnV0dG9ue2N1cnNvcjpwb2ludGVyfS5wcmltYXJ5LC5hY3RpdmV7YmFja2dyb3VuZDp2YXIoLS1waW5rKTtib3JkZXItY29sb3I6dmFyKC0tcGluayk7Zm9udC13ZWlnaHQ6ODAwfS5wYW5lbCwuY2FyZHtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTZweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxNDVkZWcsdmFyKC0tcCksIzA2MjEyNik7cGFkZGluZzoxM3B4O21hcmdpbjoxMnB4IDB9LmhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2NvbG9yOnZhcigtLW0pO2ZvbnQtc2l6ZToxMnB4fS50ZWFtc3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciBhdXRvIDFmcjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDttYXJnaW46MTdweCAwfS50ZWFte2ZvbnQtd2VpZ2h0Ojg1MDtmb250LXNpemU6MTdweDtvdmVyZmxvdy13cmFwOmFueXdoZXJlfS50ZWFtOmxhc3QtY2hpbGR7dGV4dC1hbGlnbjpyaWdodH0uc2NvcmV7Zm9udC13ZWlnaHQ6OTUwO2ZvbnQtc2l6ZToyNnB4O3doaXRlLXNwYWNlOm5vd3JhcH0ubWV0YXt0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjp2YXIoLS1tKTtmb250LXNpemU6MTFweH0udGFic3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7Z2FwOjRweDtiYWNrZ3JvdW5kOiMwNjIxMjY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzozcHg7bWFyZ2luOjEycHggMH0udGFicyBidXR0b257Ym9yZGVyOjA7YmFja2dyb3VuZDp0cmFuc3BhcmVudH0udGFicyBidXR0b24uYWN0aXZle2JhY2tncm91bmQ6dmFyKC0tcGluayl9LmdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyO2dhcDoxMHB4fS50YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1zcGFjaW5nOjAgNXB4fS50YWJsZSB0ZHtiYWNrZ3JvdW5kOiMwNjI0MmE7cGFkZGluZzoxMHB4O2JvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpfS50YWJsZSB0ZDpmaXJzdC1jaGlsZHtib3JkZXItbGVmdDoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo5cHggMCAwIDlweDtjb2xvcjp2YXIoLS1tKX0udGFibGUgdGQ6bGFzdC1jaGlsZHtib3JkZXItcmlnaHQ6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MCA5cHggOXB4IDA7Zm9udC13ZWlnaHQ6ODAwfS5ncm91cHtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTFweDtwYWRkaW5nOjhweH0uZ3R7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6ODUwO21hcmdpbjo0cHggM3B4IDhweH0uYmFye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6NzVweCAxZnIgNDBweDtnYXA6N3B4O2FsaWduLWl0ZW1zOmNlbnRlcjtmb250LXNpemU6MTJweDtwYWRkaW5nOjVweCAwfS50cmFja3toZWlnaHQ6MTFweDtib3JkZXItcmFkaXVzOjIwcHg7YmFja2dyb3VuZDojMTkzZDQ0O292ZXJmbG93OmhpZGRlbn0uZmlsbHtoZWlnaHQ6MTAwJTtiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTtib3JkZXItcmFkaXVzOjIwcHh9LmZpbGwuYW1iZXJ7YmFja2dyb3VuZDp2YXIoLS1hbWJlcil9LmZpbGwuZ3JheXtiYWNrZ3JvdW5kOnZhcigtLWdyYXkpfS5vZGRze2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSk7Z2FwOjdweH0ub2Rke2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGEzMDM3O2JvcmRlci1yYWRpdXM6MTFweDtwYWRkaW5nOjlweDt0ZXh0LWFsaWduOmNlbnRlcjtvdmVyZmxvdy13cmFwOmFueXdoZXJlfS5vZGQgbGFiZWx7ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tKTtmb250LXNpemU6MTFweH0ub2RkIHN0cm9uZ3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxOHB4fS5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH0uZW1wdHl7cGFkZGluZzoxOHB4O3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLW0pfS5lcnJ7Y29sb3I6I2ZmOWJhYX0uc3RhdHRlYW17cGFkZGluZzoxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMHB4O21hcmdpbjo4cHggMH0uc3RhdGxpbmV7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6NXB4IDA7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgIzEyM2E0MX1AbWVkaWEobWF4LXdpZHRoOjY1MHB4KXsuZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5vZGRze2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKX0udGVhbXtmb250LXNpemU6MTRweH0uc2NvcmV7Zm9udC1zaXplOjIzcHh9fQojbWF0Y2hTZWFyY2h7ZmxleDowIDEgMjIwcHghaW1wb3J0YW50O21pbi13aWR0aDoxMjBweCFpbXBvcnRhbnQ7bWF4LXdpZHRoOjI2MHB4fSNzZWFyY2hNYXRjaCwjY2xlYXJNYXRjaFNlYXJjaHtwYWRkaW5nOjhweCAxMHB4O2ZvbnQtc2l6ZToxMnB4fUBtZWRpYShtYXgtd2lkdGg6NjUwcHgpeyNtYXRjaFNlYXJjaFBhbmVsIC50b29sYmFye2dhcDo2cHh9I21hdGNoU2VhcmNoe21heC13aWR0aDpub25lO2ZsZXg6MSAxIDE1MHB4IWltcG9ydGFudH19Ci5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH0uYXJjaGl2ZS1saXN0e2Rpc3BsYXk6Z3JpZDtnYXA6OXB4fS5hcmNoaXZlLWl0ZW17Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4O2JhY2tncm91bmQ6IzA2MjQyYX0uYXJjaGl2ZS1pdGVtIC50aXRsZXtmb250LXdlaWdodDo4NTA7bWFyZ2luLWJvdHRvbTo3cHh9LmFyY2hpdmUtaXRlbSAucm93bGluZXtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjhweDtwYWRkaW5nOjRweCAwfS5hcmNoaXZlLWl0ZW0gLnJvd2xpbmUgc3Bhbntjb2xvcjp2YXIoLS1tKX0uYXJjaGl2ZS1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OHB4O21hcmdpbi10b3A6OXB4O2ZsZXgtd3JhcDp3cmFwfS5hcmNoaXZlLWFjdGlvbnMgYnV0dG9ue3BhZGRpbmc6N3B4IDEwcHh9PC9zdHlsZT48L2hlYWQ+PGJvZHk+PGhlYWRlcj48ZGl2PjxkaXYgY2xhc3M9ImxvZ28iPldJTlNDT1BFIDxzcGFuPkxJVkU8L3NwYW4+PC9kaXY+PGRpdiBjbGFzcz0ic3ViIj5DYW5sxLEgZnV0Ym9sIGFuYWxpeiB2ZSBhbGFybSBzaXN0ZW1pPC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0ic21hbGwiIGlkPSJjb25uIj5CQcSeTEFOSVlPUjwvZGl2PjwvaGVhZGVyPjxtYWluPjxkaXYgY2xhc3M9InRvb2xiYXIiPjxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJyZWZyZXNoIj7ihrsgQ2FubMSxIG1hw6dsYXI8L2J1dHRvbj48aW5wdXQgaWQ9ImRhdGUiIHR5cGU9ImRhdGUiPjxidXR0b24gaWQ9ImJ1bGxldGluIj5Cw7xsdGVuPC9idXR0b24+PGJ1dHRvbiBpZD0ic2hvd0FuYWx5c2VzIj5Hw7xuw7xuIEFuYWxpemxlcmk8L2J1dHRvbj48YnV0dG9uIGlkPSJzaG93Q291cG9ucyI+R8O8bsO8biBLdXBvbmxhcsSxPC9idXR0b24+PHNlbGVjdCBpZD0iZmlsdGVyIj48b3B0aW9uIHZhbHVlPSJhbGwiPlTDvG0gbWHDp2xhcjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9ImxpdmUiPkNhbmzEsTwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PjxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9Im1hdGNoU2VhcmNoUGFuZWwiPjxoMyBzdHlsZT0ibWFyZ2luOjJweCAwIDhweCI+8J+UjiAx4oCZZSAxIE1Bw4cgQVJBPC9oMz48ZGl2IGNsYXNzPSJ0b29sYmFyIiBzdHlsZT0ibWFyZ2luOjAiPjxpbnB1dCBpZD0ibWF0Y2hTZWFyY2giIHR5cGU9InNlYXJjaCIgcGxhY2Vob2xkZXI9IlRha8SxbSBhZMSxOiBGZW5lcmJhaMOnZSwgQmFyY2Vsb25h4oCmIiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoxODBweCI+PGJ1dHRvbiBpZD0ic2VhcmNoTWF0Y2giIGNsYXNzPSJwcmltYXJ5Ij5NYcOnIEFyYTwvYnV0dG9uPjxidXR0b24gaWQ9ImNsZWFyTWF0Y2hTZWFyY2giPlRlbWl6bGU8L2J1dHRvbj48L2Rpdj48ZGl2IGlkPSJtYXRjaFNlYXJjaFJlc3VsdCIgY2xhc3M9InNtYWxsIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPkFyYW1hayBpw6dpbiB0YWvEsW0gYWTEsW7EsSB5YXouPC9kaXY+PC9zZWN0aW9uPjxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9ImNvdXBvblBhbmVsIj48aDMgc3R5bGU9Im1hcmdpbjoycHggMCAxMHB4Ij7wn46vIFdJTlNDT1BFIEtVUE9OTEFSSTwvaDM+PGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2dhcDo4cHg7ZmxleC13cmFwOndyYXAiPjxidXR0b24gaWQ9Im1ha2VDb3Vwb24iIGNsYXNzPSJwcmltYXJ5Ij7imr0gTWHDpyDDlm7DvCBLdXBvbnUgKEVuIGF6IDIgbWHDpyk8L2J1dHRvbj48YnV0dG9uIGlkPSJtYWtlU3VycHJpc2VDb3Vwb24iIHN0eWxlPSJiYWNrZ3JvdW5kOiNmZmNjNjY7Y29sb3I6IzIwMTcwMDtmb250LXdlaWdodDo5MDA7Ym9yZGVyOm5vbmUiPvCfjrIgTWHDpyDDlm7DvCBTw7xycHJpeiAoMTAgbWHDpyk8L2J1dHRvbj48YnV0dG9uIGlkPSJtYWtlTGl2ZUJlc3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiM0MmU2YTA7Y29sb3I6IzA0MTkxZTtmb250LXdlaWdodDo5MDA7Ym9yZGVyOm5vbmUiPuKaoSBDYW5sxLEgRW4gR8O8dmVuaWxpciBUZWsgVGVyY2loPC9idXR0b24+PC9kaXY+PGRpdiBpZD0iY291cG9uUmVzdWx0IiBjbGFzcz0ic21hbGwiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPjwvZGl2Pjwvc2VjdGlvbj48c2VjdGlvbiBjbGFzcz0icGFuZWwgaGlkZGVuIiBpZD0iYW5hbHlzZXNBcmNoaXZlIj48ZGl2IGNsYXNzPSJoZWFkIj48aDM+8J+TiyBHw7xuw7xuIEFuYWxpemxlcmk8L2gzPjxidXR0b24gb25jbGljaz0iY2xvc2VBcmNoaXZlcygpIj5LYXBhdDwvYnV0dG9uPjwvZGl2PjxkaXYgaWQ9ImFuYWx5c2VzQXJjaGl2ZUxpc3QiIGNsYXNzPSJhcmNoaXZlLWxpc3QiPlnDvGtsZW5peW9y4oCmPC9kaXY+PC9zZWN0aW9uPjxzZWN0aW9uIGNsYXNzPSJwYW5lbCBoaWRkZW4iIGlkPSJjb3Vwb25zQXJjaGl2ZSI+PGRpdiBjbGFzcz0iaGVhZCI+PGgzPvCfjp/vuI8gR8O8bsO8biBLdXBvbmxhcsSxPC9oMz48YnV0dG9uIG9uY2xpY2s9ImNsb3NlQXJjaGl2ZXMoKSI+S2FwYXQ8L2J1dHRvbj48L2Rpdj48ZGl2IGlkPSJjb3Vwb25zQXJjaGl2ZUxpc3QiIGNsYXNzPSJhcmNoaXZlLWxpc3QiPlnDvGtsZW5peW9y4oCmPC9kaXY+PC9zZWN0aW9uPjxkaXYgaWQ9Im1zZyIgY2xhc3M9InNtYWxsIj48L2Rpdj48c2VjdGlvbiBpZD0ibWF0Y2hlcyI+PGRpdiBjbGFzcz0iZW1wdHkiPk1hw6dsYXIgecO8a2xlbml5b3LigKY8L2Rpdj48L3NlY3Rpb24+PC9tYWluPjxzY3JpcHQ+CmNvbnN0ICQ9eD0+ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoeCk7bGV0IG1hdGNoZXM9W10sYnVsbGV0aW5NYXRjaGVzPVtdO2NvbnN0IGVzYz14PT5TdHJpbmcoeD8/JycpLnJlcGxhY2UoL1smPD4iJ10vZyxjPT4oeycmJzonJmFtcDsnLCc8JzonJmx0OycsJz4nOicmZ3Q7JywnIic6JyZxdW90OycsIiciOicmIzM5Oyd9W2NdKSk7ZnVuY3Rpb24gYmFyKGxhYmVsLHYsY2xzPScnKXtpZih2PT1udWxsfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcih2KSkpcmV0dXJuIGA8ZGl2IGNsYXNzPSJiYXIiPjxzcGFuPiR7ZXNjKGxhYmVsKX08L3NwYW4+PGRpdiBjbGFzcz0idHJhY2siPjwvZGl2PjxiPuKAlDwvYj48L2Rpdj5gO3Y9TWF0aC5tYXgoMCxNYXRoLm1pbigxMDAsTnVtYmVyKHYpKSk7cmV0dXJuIGA8ZGl2IGNsYXNzPSJiYXIiPjxzcGFuPiR7ZXNjKGxhYmVsKX08L3NwYW4+PGRpdiBjbGFzcz0idHJhY2siPjxkaXYgY2xhc3M9ImZpbGwgJHtjbHN9IiBzdHlsZT0id2lkdGg6JHt2fSUiPjwvZGl2PjwvZGl2PjxiPiR7di50b0ZpeGVkKDEpfSU8L2I+PC9kaXY+YH0KZnVuY3Rpb24gY2FyZChtKXtyZXR1cm4gYDxhcnRpY2xlIGNsYXNzPSJjYXJkIiBpZD0ibSR7TnVtYmVyKG0uaWQpfSI+PGRpdiBjbGFzcz0iaGVhZCI+PHNwYW4+JHtlc2MobS5jb3VudHJ5fHwnJyl9IMK3ICR7ZXNjKG0ubGVhZ3VlfHwnJyl9PC9zcGFuPjxzcGFuPiR7ZXNjKG0uc3RhdHVzPT09J05TJz8nQkHFnkxBTUFESSc6KG0uc3RhdHVzPT09J0ZUJz8nTUHDhyBCxLBUVMSwJzptLnN0YXR1c3x8JycpKX0ke20ubWludXRlIT1udWxsJiYhWydOUycsJ0ZUJ10uaW5jbHVkZXMobS5zdGF0dXMpPycgwrcgJytlc2MobS5taW51dGUpKyInIjonJ308L3NwYW4+PC9kaXY+PGRpdiBjbGFzcz0idGVhbXMiPjxkaXYgY2xhc3M9InRlYW0iPiR7ZXNjKG0uaG9tZSl9PC9kaXY+PGRpdiBjbGFzcz0ic2NvcmUiPiR7ZXNjKG0uaG9tZVNjb3JlPz8n4oCTJyl9IDogJHtlc2MobS5hd2F5U2NvcmU/PyfigJMnKX08L2Rpdj48ZGl2IGNsYXNzPSJ0ZWFtIj4ke2VzYyhtLmF3YXkpfTwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9Im1ldGEiPiR7bS5maXh0dXJlRGF0ZT9uZXcgRGF0ZShtLmZpeHR1cmVEYXRlKS50b0xvY2FsZVN0cmluZygndHItVFInKTonJ308L2Rpdj48ZGl2IGNsYXNzPSJ0YWJzIj48YnV0dG9uIGNsYXNzPSJhY3RpdmUiIG9uY2xpY2s9ImFuYWx5emUoJHtOdW1iZXIobS5pZCl9LCcke20uc3RhdHVzPT09J05TJz8ncHJlbWF0Y2gnOidsaXZlJ30nKSI+TUHDhyBBTkFMxLBaxLA8L2J1dHRvbj48YnV0dG9uIG9uY2xpY2s9InN0YXRzKCR7TnVtYmVyKG0uaWQpfSkiPsSwU1RBVMSwU1TEsEs8L2J1dHRvbj48L2Rpdj48ZGl2IGlkPSJhJHtOdW1iZXIobS5pZCl9Ij48ZGl2IGNsYXNzPSJlbXB0eSI+TWHDpyBhbmFsaXppIGnDp2luIGRva3VuLjwvZGl2PjwvZGl2PjxkaXYgaWQ9InMke051bWJlcihtLmlkKX0iIGNsYXNzPSJoaWRkZW4iPjwvZGl2PjwvYXJ0aWNsZT5gfWZ1bmN0aW9uIHJlbmRlcigpe2xldCBhPSQoJ2ZpbHRlcicpLnZhbHVlPT09J2xpdmUnP21hdGNoZXMuZmlsdGVyKG09PiFbJ0ZUJywnQUVUJywnUEVOJywnTlMnXS5pbmNsdWRlcyhtLnN0YXR1cykpOm1hdGNoZXM7JCgnbWF0Y2hlcycpLmlubmVySFRNTD1hLmxlbmd0aD9hLm1hcChjYXJkKS5qb2luKCcnKTonPGRpdiBjbGFzcz0iZW1wdHkiPkJ1IGxpc3RlZGUgbWHDpyBidWx1bmFtYWTEsS48L2Rpdj4nfWFzeW5jIGZ1bmN0aW9uIGxpdmUoKXsgJCgnbWF0Y2hlcycpLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZW1wdHkiPkNhbmzEsSBtYcOnbGFyIHnDvGtsZW5peW9y4oCmPC9kaXY+Jzt0cnl7bGV0IHI9YXdhaXQgZmV0Y2goJy9hcGkvbGl2ZScpLGo9YXdhaXQgci5qc29uKCk7aWYoIXIub2spdGhyb3cgRXJyb3Ioai5kZXRhaWx8fGouZXJyb3IpO21hdGNoZXM9ai5tYXRjaGVzfHxbXTskKCdjb25uJykudGV4dENvbnRlbnQ9J1NVTlVDVSBCQcSeTEknOyQoJ21zZycpLnRleHRDb250ZW50PWAke21hdGNoZXMubGVuZ3RofSBtYcOnIMK3ICR7bmV3IERhdGUoai5mZXRjaGVkQXR8fERhdGUubm93KCkpLnRvTG9jYWxlVGltZVN0cmluZygndHItVFInKX1gO3JlbmRlcigpfWNhdGNoKGUpeyQoJ2Nvbm4nKS50ZXh0Q29udGVudD0nSEFUQSc7JCgnbXNnJykuaW5uZXJIVE1MPWA8c3BhbiBjbGFzcz0iZXJyIj4ke2VzYyhlLm1lc3NhZ2UpfTwvc3Bhbj5gOyQoJ21hdGNoZXMnKS5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImVtcHR5Ij5NYcOnbGFyIGFsxLFuYW1hZMSxLjwvZGl2Pid9fWFzeW5jIGZ1bmN0aW9uIGJ1bGxldGluKCl7bGV0IGQ9JCgnZGF0ZScpLnZhbHVlO2lmKCFkKXJldHVybjt0cnl7bGV0IHI9YXdhaXQgZmV0Y2goJy9hcGkvZml4dHVyZXM/ZGF0ZT0nK2VuY29kZVVSSUNvbXBvbmVudChkKSksaj1hd2FpdCByLmpzb24oKTtpZighci5vayl0aHJvdyBFcnJvcihqLmRldGFpbHx8ai5lcnJvcik7YnVsbGV0aW5NYXRjaGVzPWoubWF0Y2hlc3x8W107JCgnbWF0Y2hlcycpLmlubmVySFRNTD1idWxsZXRpbk1hdGNoZXMubGVuZ3RoP2J1bGxldGluTWF0Y2hlcy5tYXAoY2FyZCkuam9pbignJyk6JzxkaXYgY2xhc3M9ImVtcHR5Ij5NYcOnIGJ1bHVuYW1hZMSxLjwvZGl2Pic7JCgnbXNnJykudGV4dENvbnRlbnQ9YCR7YnVsbGV0aW5NYXRjaGVzLmxlbmd0aH0gbWHDpyDCtyAke2R9YH1jYXRjaChlKXskKCdtc2cnKS5pbm5lckhUTUw9YDxzcGFuIGNsYXNzPSJlcnIiPiR7ZXNjKGUubWVzc2FnZSl9PC9zcGFuPmB9fWFzeW5jIGZ1bmN0aW9uIHNlYXJjaE1hdGNoKCl7Y29uc3QgcT0kKCdtYXRjaFNlYXJjaCcpLnZhbHVlLnRyaW0oKS50b0xvY2FsZUxvd2VyQ2FzZSgndHItVFInKTtjb25zdCBvdXQ9JCgnbWF0Y2hTZWFyY2hSZXN1bHQnKTtpZighcSl7b3V0LmlubmVySFRNTD0nPHNwYW4gY2xhc3M9ImVyciI+w5ZuY2UgYmlyIHRha8SxbSBhZMSxIHlheiBrcmFsLjwvc3Bhbj4nO3JldHVybn1jb25zdCBkPSQoJ2RhdGUnKS52YWx1ZTtpZighZCl7b3V0LmlubmVySFRNTD0nPHNwYW4gY2xhc3M9ImVyciI+w5ZuY2UgdGFyaWggc2XDpy48L3NwYW4+JztyZXR1cm59b3V0LnRleHRDb250ZW50PSdCw7xsdGVuZGVraSBtYcOnbGFyIGFyYW7EsXlvcuKApic7JCgnc2VhcmNoTWF0Y2gnKS5kaXNhYmxlZD10cnVlO3RyeXtsZXQgc291cmNlPWJ1bGxldGluTWF0Y2hlcztpZighc291cmNlLmxlbmd0aHx8IXNvdXJjZS5zb21lKG09PlN0cmluZyhtLmZpeHR1cmVEYXRlfHwnJykuc2xpY2UoMCwxMCk9PT1kKSl7Y29uc3Qgcj1hd2FpdCBmZXRjaCgnL2FwaS9maXh0dXJlcz9kYXRlPScrZW5jb2RlVVJJQ29tcG9uZW50KGQpLHtzaWduYWw6QWJvcnRTaWduYWwudGltZW91dCgyMDAwMCl9KTtjb25zdCBqPWF3YWl0IHIuanNvbigpO2lmKCFyLm9rKXRocm93IEVycm9yKGouZGV0YWlsfHxqLmVycm9yfHwnQsO8bHRlbiBhbMSxbmFtYWTEsScpO3NvdXJjZT1qLm1hdGNoZXN8fFtdO2J1bGxldGluTWF0Y2hlcz1zb3VyY2V9Y29uc3QgZm91bmQ9c291cmNlLmZpbHRlcihtPT5gJHttLmhvbWV8fCcnfSAke20uYXdheXx8Jyd9YC50b0xvY2FsZUxvd2VyQ2FzZSgndHItVFInKS5pbmNsdWRlcyhxKSk7aWYoIWZvdW5kLmxlbmd0aCl7b3V0LnRleHRDb250ZW50PWDigJwkeyQoJ21hdGNoU2VhcmNoJykudmFsdWUudHJpbSgpfeKAnSBpw6dpbiAke2R9IGLDvGx0ZW5pbmRlIG1hw6cgYnVsdW5hbWFkxLEuYDtyZXR1cm59bWF0Y2hlcz1zb3VyY2U7JCgnZmlsdGVyJykudmFsdWU9J2FsbCc7JCgnbWF0Y2hlcycpLmlubmVySFRNTD1mb3VuZC5tYXAoY2FyZCkuam9pbignJyk7b3V0LnRleHRDb250ZW50PWAke2ZvdW5kLmxlbmd0aH0gZcWfbGXFn2VuIG1hw6cgYnVsdW5kdSDCtyAke2R9LiBBbmFsaXogdmV5YSBpc3RhdGlzdGlrIGnDp2luIG1hw6dhIGRva3VuLmA7JCgnbXNnJykudGV4dENvbnRlbnQ9YEFyYW1hIHNvbnVjdTogJHtmb3VuZC5sZW5ndGh9IG1hw6cgwrcgJHtkfWA7JCgnbWF0Y2hlcycpLnNjcm9sbEludG9WaWV3KHtiZWhhdmlvcjonc21vb3RoJyxibG9jazonc3RhcnQnfSl9Y2F0Y2goZSl7b3V0LmlubmVySFRNTD1gPHNwYW4gY2xhc3M9ImVyciI+QXJhbWEgYmHFn2FyxLFzxLF6OiAke2VzYyhlLm1lc3NhZ2UpfTwvc3Bhbj5gfWZpbmFsbHl7JCgnc2VhcmNoTWF0Y2gnKS5kaXNhYmxlZD1mYWxzZX19ZnVuY3Rpb24gY2xlYXJNYXRjaFNlYXJjaCgpeyQoJ21hdGNoU2VhcmNoJykudmFsdWU9Jyc7JCgnbWF0Y2hTZWFyY2hSZXN1bHQnKS50ZXh0Q29udGVudD0nQXJhbWFrIGnDp2luIHRha8SxbSBhZMSxbsSxIHlhei4nO2J1bGxldGluTWF0Y2hlcz1bXX0KYXN5bmMgZnVuY3Rpb24gYW5hbHl6ZShpZCxtb2RlKXtsZXQgYm94PSQoJ2EnK2lkKTtib3guaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJlbXB0eSI+QW5hbGl6IGVkaWxpeW9y4oCmPC9kaXY+Jzt0cnl7bGV0IHI9YXdhaXQgZmV0Y2goYC9hcGkvbWF0Y2gvJHtpZH0vYW5hbHl6ZT9tb2RlPSR7bW9kZX1gKSxqPWF3YWl0IHIuanNvbigpO2lmKCFyLm9rKXRocm93IEVycm9yKGouZGV0YWlsfHxqLmVycm9yKTtsZXQgcD1qLm1hcmtldFBlcmNlbnRhZ2VzfHx7fTtjb25zdCBwY3Q9KGtleSk9Pntjb25zdCB4PXBba2V5XTtyZXR1cm4geCYmeC5wZXJjZW50IT1udWxsJiZOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHgucGVyY2VudCkpP2AlJHtlc2MoeC5wZXJjZW50KX0gPHNwYW4gY2xhc3M9InNtYWxsIj4oJHtlc2MoeC5zb3VyY2V8fCdLYXluYWsgYmVsaXJ0aWxtZWRpJyl9IMK3IHNvbiA1IG1hw6cgw7ZybmVrbGVtaTogJHtlc2MoeC5zYW1wbGVTaXplfHwwKX0pPC9zcGFuPmA6J1ZlcmkgeW9rJ307Ym94LmlubmVySFRNTD1gPGRpdiBjbGFzcz0iZ3JpZCI+PGRpdj48dGFibGUgY2xhc3M9InRhYmxlIj48dHI+PHRkPkFOQSBURVJDxLBIPC90ZD48dGQ+JHtlc2Moai5tYWluUGlja3x8J+KAlCcpfTwvdGQ+PC90cj48dHI+PHRkPkFMVEVSTkFUxLBGPC90ZD48dGQ+JHtlc2Moai5hbHRlcm5hdGl2ZXx8J+KAlCcpfTwvdGQ+PC90cj48dHI+PHRkPsSwWSBTS09SPC90ZD48dGQ+JHtlc2Moai5oYWxmVGltZVNjb3JlfHwn4oCUJyl9PC90ZD48L3RyPjx0cj48dGQ+TVMgU0tPUjwvdGQ+PHRkPiR7ZXNjKGouZnVsbFRpbWVTY29yZXx8J+KAlCcpfTwvdGQ+PC90cj48dHI+PHRkPlPDnFJQUsSwWjwvdGQ+PHRkPiR7ZXNjKGouc3VycHJpc2V8fCfigJQnKX08L3RkPjwvdHI+PHRyPjx0ZD7EsFkgMC41IMOcU1Q8L3RkPjx0ZD4ke3BjdCgnaHQwNScpfTwvdGQ+PC90cj48dHI+PHRkPsSwWSAxLjUgw5xTVDwvdGQ+PHRkPiR7cGN0KCdodDE1Jyl9PC90ZD48L3RyPjx0cj48dGQ+RVYgMS41IMOcU1Q8L3RkPjx0ZD4ke3BjdCgnaG9tZTE1Jyl9PC90ZD48L3RyPjx0cj48dGQ+REVQIDEuNSDDnFNUPC90ZD48dGQ+JHtwY3QoJ2F3YXkxNScpfTwvdGQ+PC90cj48dHI+PHRkPk1TIDAuNSDDnFNUPC90ZD48dGQ+JHtwY3QoJ21zMDUnKX08L3RkPjwvdHI+PHRyPjx0ZD5NUyAxLjUgw5xTVDwvdGQ+PHRkPiR7cGN0KCdtczE1Jyl9PC90ZD48L3RyPjx0cj48dGQ+TVMgMi41IMOcU1Q8L3RkPjx0ZD4ke3BjdCgnbXMyNScpfTwvdGQ+PC90cj48dHI+PHRkPk1TIDMuNSDDnFNUPC90ZD48dGQ+JHtwY3QoJ21zMzUnKX08L3RkPjwvdHI+PHRyPjx0ZD5LRyBWQVI8L3RkPjx0ZD4ke3BjdCgnYnR0cycpfTwvdGQ+PC90cj48dHI+PHRkPlnDnFpERSBWRVLEsFPEsDwvdGQ+PHRkPkFQSS1Gb290YmFsbCBnZXLDp2VrIHRhbWFtbGFubcSxxZ8gbWHDp2xhci48L3RkPjwvdHI+PC90YWJsZT48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJzbWFsbCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4ke2VzYyhqLm5vdGV8fCdBbmFsaXogbm90dSB5b2suJyl9PC9kaXY+PGRpdiBjbGFzcz0idG9vbGJhciI+PGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgb25jbGljaz0iYXBwcm92ZUFuYWx5c2lzKCR7aWR9LCcke21vZGV9JykiPkFuYWxpemkgT25heWxhIHZlIEtheWRldDwvYnV0dG9uPjwvZGl2PmB9Y2F0Y2goZSl7Ym94LmlubmVySFRNTD1gPGRpdiBjbGFzcz0ic21hbGwgZXJyIj4ke2VzYyhlLm1lc3NhZ2UpfTwvZGl2PmB9fQphc3luYyBmdW5jdGlvbiBzdGF0cyhpZCl7bGV0IGI9JCgncycraWQpO2IuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7Yi5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImVtcHR5Ij7EsHN0YXRpc3RpayB5w7xrbGVuaXlvcuKApjwvZGl2Pic7dHJ5e2xldCByPWF3YWl0IGZldGNoKGAvYXBpL21hdGNoLyR7aWR9L3N0YXRzYCksaj1hd2FpdCByLmpzb24oKTtpZighci5vayl0aHJvdyBFcnJvcihqLmVycm9yfHwnxLBzdGF0aXN0aWsgYWzEsW5hbWFkxLEnKTtsZXQgbGlzdD1qLnN0YXRzfHxbXTtpZighbGlzdC5sZW5ndGgpe2IuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJwYW5lbCI+xLBzdGF0aXN0aWsgdmVyaXNpIGJ1bHVuYW1hZMSxLjwvZGl2Pic7cmV0dXJuO31iLmlubmVySFRNTD1gPGRpdiBjbGFzcz0icGFuZWwiPjxoMz7EsFNUQVTEsFNUxLBLPC9oMz4ke2xpc3QubWFwKHQ9PntsZXQgbmFtZT10LnRlYW0/Lm5hbWV8fHQudGVhbXx8J1Rha8SxbSc7bGV0IHN0TGlzdD1BcnJheS5pc0FycmF5KHQuc3RhdGlzdGljcyk/dC5zdGF0aXN0aWNzOih0eXBlb2YgdC5zdGF0aXN0aWNzPT09J29iamVjdCc/T2JqZWN0LmVudHJpZXModC5zdGF0aXN0aWNzKS5tYXAoKFt0eXBlLHZhbHVlXSk9Pih7dHlwZSx2YWx1ZX0pKTpbXSk7cmV0dXJuIGA8ZGl2IGNsYXNzPSJzdGF0dGVhbSI+PGI+JHtlc2MobmFtZSl9PC9iPiR7c3RMaXN0Lm1hcChzPT5gPGRpdiBjbGFzcz0ic3RhdGxpbmUiPjxzcGFuPiR7ZXNjKHMudHlwZXx8JycpfTwvc3Bhbj48Yj4ke2VzYyhzLnZhbHVlPz8nLScpfTwvYj48L2Rpdj5gKS5qb2luKCcnKX08L2Rpdj5gfSkuam9pbignJyl9PC9kaXY+YH1jYXRjaChlKXtiLmlubmVySFRNTD1gPGRpdiBjbGFzcz0ic21hbGwgZXJyIj4ke2VzYyhlLm1lc3NhZ2UpfTwvZGl2PmB9fQpmdW5jdGlvbiByZW5kZXJDb3Vwb24oZCl7Y29uc3QgYm94PSQoJ2NvdXBvblJlc3VsdCcpO2lmKGQuc3RhdHVzPT09J0VSUk9SJ3x8ZC5lcnJvcil7Ym94LmlubmVySFRNTD1gPGRpdiBjbGFzcz0iZXJyIj48Yj4ke2VzYyhkLmVycm9yfHwnS3Vwb24gb2x1xZ90dXJ1bGFtYWTEsS4nKX08L2I+PGRpdj4ke2VzYyhkLmRldGFpbHx8JycpfTwvZGl2PjwvZGl2PmA7cmV0dXJuO31pZihkLnN0YXR1cz09PSdOT19NQVRDSEVTJ3x8IWQucGlja3N8fCFkLnBpY2tzLmxlbmd0aCl7Ym94LmlubmVySFRNTD1gPGRpdiBjbGFzcz0iZXJyIj48Yj4ke2VzYyhkLm1lc3NhZ2V8fCdZZXRlcmxpIHNhecSxZGEgZG/En3J1bGFuYWJpbGlyIG9yYW5sxLEgbWHDpyBidWx1bmFtYWTEsS4nKX08L2I+PGRpdj4ke2VzYyhkLmRldGFpbHx8JycpfTwvZGl2PjwvZGl2PmA7cmV0dXJuO31jb25zdCB0Zz1kLnRlbGVncmFtfHx7fTtjb25zdCB0Z0xhYmVsPXRnLnNlbnQ/KHRnLmR1cGxpY2F0ZVN1cHByZXNzZWQ/J1RlbGVncmFtOiBEYWhhIMO2bmNlIGfDtm5kZXJpbGRpLCB0ZWtyYXIgZW5nZWxsZW5kaSc6J1RlbGVncmFtOiBPdG9tYXRpayBnw7ZuZGVyaWxkaScpOih0Zy5lcnJvcnx8dGcucmVhc29uP2BUZWxlZ3JhbSBnw7ZuZGVyaWxlbWVkaTogJHt0Zy5lcnJvcnx8dGcucmVhc29ufWA6J1RlbGVncmFtIGfDtm5kZXJpbSBkdXJ1bXUgZG/En3J1bGFuYW1hZMSxJyk7Ym94LmlubmVySFRNTD1gPGRpdiBjbGFzcz0iaGVhZCI+PHNwYW4+JHtkLnR5cGU9PT0nc3VycHJpc2UnID8gJ/CfjrIgTUHDhyDDlk7DnCBTw5xSUFLEsFogMTAgTUHDhycgOiBkLnR5cGU9PT0nbGl2ZScgPyAn4pqhIENBTkxJIEVOIEfDnFZFTsSwTMSwUiBURUsgVEVSQ8SwSCcgOiAn8J+OryBNQcOHIMOWTsOcIEtVUE9OVSd9IMK3ICR7ZXNjKGQuZGF0ZSl9PC9zcGFuPjxzcGFuPjxiPiR7dGcuc2VudD8nVEVMRUdSQU0gR8OWTkRFUsSwTETEsCc6J0fDlk5ERVLEsE0gS09OVFJPTMOcJ308L2I+PC9zcGFuPjwvZGl2PjxkaXYgc3R5bGU9Im1hcmdpbjoxMHB4IDAiPiR7ZC5waWNrcy5tYXAoKHAsaSk9PmA8ZGl2IGNsYXNzPSJzdGF0dGVhbSI+PGRpdiBjbGFzcz0iaGVhZCI+PHNwYW4+JHtlc2MocC5sZWFndWUpfTwvc3Bhbj48c3Bhbj4ke3AubWludXRlIT1udWxsP2VzYyhwLm1pbnV0ZSkrIicgwrcgU2tvcjogIitlc2MocC5jdXJyZW50U2NvcmV8fCcwLTAnKTonTWHDpyDDtm7DvCd9PC9zcGFuPjwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtd2VpZ2h0Ojg1MDttYXJnaW46OHB4IDAiPiR7ZXNjKHAuaG9tZSl9IFZTICR7ZXNjKHAuYXdheSl9PC9kaXY+PGRpdiBjbGFzcz0ic3RhdGxpbmUiPjxzcGFuPlRlcmNpaDwvc3Bhbj48Yj4ke2VzYyhwLm1hcmtldCl9PC9iPjwvZGl2PjxkaXYgY2xhc3M9InNtYWxsIj5PcmFuIGtheW5hxJ/EsTogJHtlc2MocC5zb3VyY2V8fCdCZWxpcnRpbG1lZGknKX0gwrcgJHtlc2MocC5vZGRzQmFzaXN8fCdPcmFuIGtheW5hxJ/EsSBkb8SfcnVsYW5tYWzEsScpfTwvZGl2PiR7cC5zdGF0c1N1bW1hcnkmJnAuc3RhdHNTdW1tYXJ5Lmxlbmd0aD9gPGRpdiBjbGFzcz0ic21hbGwiPkNhbmzEsSBpc3RhdGlzdGlrOiAke2VzYyhwLnN0YXRzU3VtbWFyeS5qb2luKCcgwrcgJykpfTwvZGl2PmA6Jyd9PC9kaXY+YCkuam9pbignJyl9PC9kaXY+PGRpdiBjbGFzcz0ic21hbGwiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+JHtlc2ModGdMYWJlbCl9LiBLdXBvbiDDvHJldGlsZGnEn2luZGUgVGVsZWdyYW0gZ8O2bmRlcmltaSBvdG9tYXRpayBkZW5lbmlyOyBtYW51ZWwgb25heSBnZXJla21lei48L2Rpdj5gfQphc3luYyBmdW5jdGlvbiBtYWtlQ291cG9uKCl7Y29uc3QgYj0kKCdtYWtlQ291cG9uJyk7Yi5kaXNhYmxlZD10cnVlO3RyeXtpZighJCgnZGF0ZScpLnZhbHVlKXRocm93IEVycm9yKCfDlm5jZSBtYcOnIHRhcmloaW5pIHNlw6cuJyk7bGV0IHI9YXdhaXQgZmV0Y2goJy9hcGkvY291cG9uL2Jlc3Q/ZGF0ZT0nK2VuY29kZVVSSUNvbXBvbmVudCgkKCdkYXRlJykudmFsdWUpKTtsZXQgZD1hd2FpdCByLmpzb24oKTtpZighci5vayYmIWQuZXJyb3IpZC5lcnJvcj0nVGVrIG1hw6cgc2XDp2lsZW1lZGkuJztyZW5kZXJDb3Vwb24oZCk7aWYoZC5tZXNzYWdlJiZkLnN0YXR1cz09PSdSRUFEWScpJCgnY291cG9uUmVzdWx0JykuaW5zZXJ0QWRqYWNlbnRIVE1MKCdiZWZvcmVlbmQnLGA8ZGl2IGNsYXNzPSJzbWFsbCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4ke2VzYyhkLm1lc3NhZ2UpfTwvZGl2PmApO31jYXRjaChlKXskKCdjb3Vwb25SZXN1bHQnKS5pbm5lckhUTUw9YDxzcGFuIGNsYXNzPSJlcnIiPiR7ZXNjKGUubWVzc2FnZSl9PC9zcGFuPmB9ZmluYWxseXtiLmRpc2FibGVkPWZhbHNlO319CmFzeW5jIGZ1bmN0aW9uIG1ha2VTdXJwcmlzZUNvdXBvbigpe2NvbnN0IGI9JCgnbWFrZVN1cnByaXNlQ291cG9uJyk7Yi5kaXNhYmxlZD10cnVlO3RyeXtpZighJCgnZGF0ZScpLnZhbHVlKXRocm93IEVycm9yKCfDlm5jZSBtYcOnIHRhcmloaW5pIHNlw6cuJyk7bGV0IHI9YXdhaXQgZmV0Y2goJy9hcGkvY291cG9uL3N1cnByaXNlP2RhdGU9JytlbmNvZGVVUklDb21wb25lbnQoJCgnZGF0ZScpLnZhbHVlKSk7bGV0IGQ9YXdhaXQgci5qc29uKCk7aWYoIXIub2smJiFkLmVycm9yKWQuZXJyb3I9JzEwIG1hw6dsxLFrIHPDvHJwcml6IGt1cG9uIG9sdcWfdHVydWxhbWFkxLEuJztyZW5kZXJDb3Vwb24oZCk7aWYoZC5tZXNzYWdlJiZkLnN0YXR1cz09PSdSRUFEWScpJCgnY291cG9uUmVzdWx0JykuaW5zZXJ0QWRqYWNlbnRIVE1MKCdiZWZvcmVlbmQnLGA8ZGl2IGNsYXNzPSJzbWFsbCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4ke2VzYyhkLm1lc3NhZ2UpfTwvZGl2PmApO31jYXRjaChlKXskKCdjb3Vwb25SZXN1bHQnKS5pbm5lckhUTUw9YDxzcGFuIGNsYXNzPSJlcnIiPiR7ZXNjKGUubWVzc2FnZSl9PC9zcGFuPmB9ZmluYWxseXtiLmRpc2FibGVkPWZhbHNlO319CmFzeW5jIGZ1bmN0aW9uIG1ha2VMaXZlQmVzdCgpe2NvbnN0IGI9JCgnbWFrZUxpdmVCZXN0Jyk7Yi5kaXNhYmxlZD10cnVlO3RyeXtsZXQgZGF0ZT0kKCdkYXRlJykudmFsdWV8fG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLDEwKTtsZXQgcj1hd2FpdCBmZXRjaCgnL2FwaS9jb3Vwb24vbGl2ZS1iZXN0P2RhdGU9JytlbmNvZGVVUklDb21wb25lbnQoZGF0ZSkpO2xldCBkPWF3YWl0IHIuanNvbigpO2lmKCFyLm9rJiYhZC5lcnJvcilkLmVycm9yPSdDYW5sxLEgdGVyY2loIGJ1bHVuYW1hZMSxLic7cmVuZGVyQ291cG9uKGQpO2lmKGQubWVzc2FnZSYmZC5zdGF0dXM9PT0nUkVBRFknKSQoJ2NvdXBvblJlc3VsdCcpLmluc2VydEFkamFjZW50SFRNTCgnYmVmb3JlZW5kJyxgPGRpdiBjbGFzcz0ic21hbGwiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+JHtlc2MoZC5tZXNzYWdlKX08L2Rpdj5gKTt9Y2F0Y2goZSl7JCgnY291cG9uUmVzdWx0JykuaW5uZXJIVE1MPWA8c3BhbiBjbGFzcz0iZXJyIj4ke2VzYyhlLm1lc3NhZ2UpfTwvc3Bhbj5gfWZpbmFsbHl7Yi5kaXNhYmxlZD1mYWxzZTt9fQphc3luYyBmdW5jdGlvbiBhcHByb3ZlQW5hbHlzaXMoaWQsbW9kZSl7Y29uc3QgbWF0Y2g9Wy4uLm1hdGNoZXMsLi4uYnVsbGV0aW5NYXRjaGVzXS5maW5kKHg9Pk51bWJlcih4LmlkKT09PU51bWJlcihpZCkpO2NvbnN0IGJveD0kKCdhJytpZCk7aWYoIW1hdGNofHwhYm94KXJldHVybjtjb25zdCB2YWxzPXt9O2JveC5xdWVyeVNlbGVjdG9yQWxsKCcudGFibGUgdHInKS5mb3JFYWNoKHJvdz0+e2NvbnN0IGM9cm93LnF1ZXJ5U2VsZWN0b3JBbGwoJ3RkJyk7aWYoYy5sZW5ndGg9PT0yKXZhbHNbY1swXS50ZXh0Q29udGVudC50cmltKCldPWNbMV0udGV4dENvbnRlbnQudHJpbSgpfSk7Y29uc3QgYW5hbHlzaXM9e21haW5QaWNrOnZhbHNbJ0FOQSBURVJDxLBIJ118fCfigJQnLGFsdGVybmF0aXZlOnZhbHNbJ0FMVEVSTkFUxLBGJ118fCfigJQnLGhhbGZUaW1lU2NvcmU6dmFsc1snxLBZIFNLT1InXXx8J+KAlCcsZnVsbFRpbWVTY29yZTp2YWxzWydNUyBTS09SJ118fCfigJQnLHN1cnByaXNlOnZhbHNbJ1PDnFJQUsSwWiddfHwn4oCUJ307dHJ5e2F3YWl0IGZldGNoKCcvYXBpL2FuYWx5c2VzL2FwcHJvdmUnLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30sYm9keTpKU09OLnN0cmluZ2lmeSh7Zml4dHVyZUlkOk51bWJlcihpZCksbWF0Y2hEYXRlOm1hdGNoLmZpeHR1cmVEYXRlfHwnJyxob21lOm1hdGNoLmhvbWUsYXdheTptYXRjaC5hd2F5LGFuYWx5c2lzfSl9KTthbGVydCgnQW5hbGl6IG9uYXlsYW5kxLEuJyk7fWNhdGNoKGUpe2FsZXJ0KCdIYXRhOiAnK2UubWVzc2FnZSk7fX0KZnVuY3Rpb24gY2xvc2VBcmNoaXZlcygpeyQoJ2FuYWx5c2VzQXJjaGl2ZScpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyQoJ2NvdXBvbnNBcmNoaXZlJykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7fQphc3luYyBmdW5jdGlvbiBsb2FkQXJjaGl2ZXMod2hpY2gpe2NvbnN0IGJveD0kKHdoaWNoPT09J2FuYWx5c2lzJz8nYW5hbHlzZXNBcmNoaXZlTGlzdCc6J2NvdXBvbnNBcmNoaXZlTGlzdCcpO2JveC50ZXh0Q29udGVudD0nWcO8a2xlbml5b3LigKYnO3RyeXtsZXQgcj1hd2FpdCBmZXRjaCgnL2FwaS9hcmNoaXZlcycpLGo9YXdhaXQgci5qc29uKCk7aWYod2hpY2g9PT0nYW5hbHlzaXMnKXtib3guaW5uZXJIVE1MPShqLmFuYWx5c2VzfHxbXSkubGVuZ3RoP2ouYW5hbHlzZXMubWFwKHg9PmA8ZGl2IGNsYXNzPSJhcmNoaXZlLWl0ZW0iPjxkaXYgY2xhc3M9InRpdGxlIj4ke2VzYyh4LmhvbWVfdGVhbSl9IFZTICR7ZXNjKHguYXdheV90ZWFtKX08L2Rpdj48ZGl2IGNsYXNzPSJyb3dsaW5lIj48c3Bhbj5BbmEgdGVyY2loPC9zcGFuPjxiPiR7ZXNjKHguYW5hbHlzaXM/Lm1haW5QaWNrfHwn4oCUJyl9PC9iPjwvZGl2PjxkaXYgY2xhc3M9InJvd2xpbmUiPjxzcGFuPsSwWSAvIE1TIHNrb3I8L3NwYW4+PGI+JHtlc2MoeC5hbmFseXNpcz8uaGFsZlRpbWVTY29yZXx8J+KAlCcpfSAvICR7ZXNjKHguYW5hbHlzaXM/LmZ1bGxUaW1lU2NvcmV8fCfigJQnKX08L2I+PC9kaXY+PC9kaXY+YCkuam9pbignJyk6JzxkaXYgY2xhc3M9ImVtcHR5Ij5LYXnEsXQgeW9rLjwvZGl2Pic7fWVsc2V7Ym94LmlubmVySFRNTD0oai5jb3Vwb25zfHxbXSkubGVuZ3RoP2ouY291cG9ucy5tYXAoeD0+YDxkaXYgY2xhc3M9ImFyY2hpdmUtaXRlbSI+PGRpdiBjbGFzcz0idGl0bGUiPiR7eC5pc0xpdmU/J/Cfjq8gQ2FubMSxIEtvbWJpbic6J0t1cG9uJ30gwrcgJHtlc2MoeC5kYXRlfHwnJyl9PC9kaXY+PC9kaXY+YCkuam9pbignJyk6JzxkaXYgY2xhc3M9ImVtcHR5Ij5LYXnEsXQgeW9rLjwvZGl2Pic7fX1jYXRjaChlKXtib3guaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJlcnIiPiR7ZXNjKGUubWVzc2FnZSl9YCB9fQp3aW5kb3cuYW5hbHl6ZT1hbmFseXplO3dpbmRvdy5zdGF0cz1zdGF0czskKCdyZWZyZXNoJykub25jbGljaz1saXZlOyQoJ2J1bGxldGluJykub25jbGljaz1idWxsZXRpbjskKCdzZWFyY2hNYXRjaCcpLm9uY2xpY2s9c2VhcmNoTWF0Y2g7JCgnbWF0Y2hTZWFyY2gnKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJyxlPT57aWYoZS5rZXk9PT0nRW50ZXInKXNlYXJjaE1hdGNoKCl9KTskKCdjbGVhck1hdGNoU2VhcmNoJykub25jbGljaz1jbGVhck1hdGNoU2VhcmNoOyQoJ21ha2VDb3Vwb24nKS5vbmNsaWNrPW1ha2VDb3Vwb247JCgnbWFrZVN1cnByaXNlQ291cG9uJykub25jbGljaz1tYWtlU3VycHJpc2VDb3Vwb247JCgnbWFrZUxpdmVCZXN0Jykub25jbGljaz1tYWtlTGl2ZUJlc3Q7JCgnc2hvd0FuYWx5c2VzJykub25jbGljaz0oKT0+e2Nsb3NlQXJjaGl2ZXMoKTskKCdhbmFseXNlc0FyY2hpdmUnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTtsb2FkQXJjaGl2ZXMoJ2FuYWx5c2lzJyk7fTskKCdzaG93Q291cG9ucycpLm9uY2xpY2s9KCk9PntjbG9zZUFyY2hpdmVzKCk7JCgnY291cG9uc0FyY2hpdmUnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTtsb2FkQXJjaGl2ZXMoJ2NvdXBvbicpO307JCgnZmlsdGVyJykub25jaGFuZ2U9cmVuZGVyO2xldCBkPW5ldyBEYXRlKCk7JCgnZGF0ZScpLnZhbHVlPWAke2QuZ2V0RnVsbFllYXIoKX0tJHtTdHJpbmcoZC5nZXRNb250aCgpKzEpLnBhZFN0YXJ0KDIsJzAnKX0tJHtTdHJpbmcoZC5nZXREYXRlKCkpLnBhZFN0YXJ0KDIsJzAnKX1gO2xpdmUoKTsKPC9zY3JpcHQ+PC9ib2R5PjwvaHRtbD4=", "base64").toString("utf8");
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
const { Pool } = pg;
const databasePool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } })
  : null;
let archiveDatabaseReady = Promise.resolve();
if (databasePool) {
  archiveDatabaseReady = (async () => {
    try {
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_archive (
        id BIGSERIAL PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('analysis','coupon')),
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await databasePool.query("CREATE INDEX IF NOT EXISTS winscope_archive_category_id_idx ON winscope_archive(category, id DESC)");
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_telegram_fixture_sent (
        fixture_id BIGINT PRIMARY KEY,
        match_date DATE,
        coupon_type TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      const [analysisRows, couponRows, sentRows] = await Promise.all([
        databasePool.query("SELECT payload FROM winscope_archive WHERE category = 'analysis' ORDER BY id DESC LIMIT 100"),
        databasePool.query("SELECT payload FROM winscope_archive WHERE category = 'coupon' ORDER BY id DESC LIMIT 50"),
        databasePool.query("SELECT fixture_id FROM winscope_telegram_fixture_sent")
      ]);
      archives.analyses = analysisRows.rows.map(row => row.payload);
      archives.coupons = couponRows.rows.map(row => row.payload);
      for (const row of sentRows.rows) telegramSentFixtureIds.add(Number(row.fixture_id));
      console.log(`[Archive] PostgreSQL arşivi yüklendi: analyses=${archives.analyses.length}, coupons=${archives.coupons.length}`);
    } catch (error) {
      console.error(`[Archive] PostgreSQL başlatılamadı; servis bellek içi arşivle devam edecek: ${error.message}`);
    }
  })();
}
async function saveArchiveItem(category, payload) {
  if (!databasePool) return { persisted: false, reason: "DATABASE_URL tanımlı değil; kayıt yalnızca çalışan süreç belleğinde tutulur." };
  try {
    await archiveDatabaseReady;
    await databasePool.query("INSERT INTO winscope_archive(category, payload) VALUES ($1, $2::jsonb)", [category, JSON.stringify(payload)]);
    await databasePool.query(`DELETE FROM winscope_archive WHERE id IN (
      SELECT id FROM winscope_archive WHERE category = $1 ORDER BY id DESC OFFSET $2
    )`, [category, category === "analysis" ? 100 : 50]);
    return { persisted: true };
  } catch (error) {
    console.error(`[Archive] Kayıt kalıcılaştırılamadı (${category}): ${error.message}`);
    return { persisted: false, error: error.message };
  }
}
// Aynı kuponun art arda tıklama/yenilemelerde tekrar Telegram'a gitmesini önler.
const telegramDeliveryCache = new Map();
// Otomatik gönderimde aynı gün aynı maçı tekrar seçmemek için takip edilir.
const autoSentFixtureKeys = new Set();
// Fixture ID bazında tekrar engeli; PostgreSQL varsa sunucu yeniden başlasa da korunur.
const telegramSentFixtureIds = new Set();
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
  return candidates.sort((a,b) => (/bet365/i.test(b.bookmaker)-/bet365/i.test(a.bookmaker)) || b.probability-a.probability || a.rank-b.rank);
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
  const out = { available: false, shotsOnTarget: 0, totalShots: 0, corners: 0,
    home: { shotsOnTarget: 0, totalShots: 0, corners: 0 }, away: { shotsOnTarget: 0, totalShots: 0, corners: 0 } };
  const seen = { home: new Set(), away: new Set() };
  for (const team of (Array.isArray(stats) ? stats : [])) {
    const teamId = Number(team.team?.id);
    const side = teamId === Number(fixture.homeId) ? "home" : teamId === Number(fixture.awayId) ? "away" : null;
    if (!side) continue;
    for (const st of (team.statistics || [])) {
      const type = String(st.type || "").toLowerCase();
      if (st.value == null || String(st.value).trim() === "" || /^[-—]+$/.test(String(st.value).trim())) continue;
      const value = Number(String(st.value).replace('%',''));
      if (!Number.isFinite(value)) continue;
      if (/shots on goal|shots on target/.test(type)) { out.shotsOnTarget += value; out[side].shotsOnTarget += value; seen[side].add("shotsOnTarget"); }
      else if (/total shots|goal attempts/.test(type)) { out.totalShots += value; out[side].totalShots += value; seen[side].add("totalShots"); }
      else if (/corner kicks|corners/.test(type)) { out.corners += value; out[side].corners += value; seen[side].add("corners"); }
    }
  }
  // A two-row response alone is not proof that usable live stats exist.
  out.available = seen.home.size > 0 && seen.away.size > 0;
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
    grouped.get(row.market).push(row);
  }
  const result = {};
  for (const [market, values] of grouped) {
    // Bet365 varsa onu kullan; yoksa aynı pazardaki en yüksek güvenilir API olasılığını kullan.
    const preferred = values.find(value => /bet365/i.test(String(value.bookmaker || "")));
    const selected = preferred || values[0];
    result[market] = Number(selected.probability) / 100;
  }
  return result;
}
function scorePrediction(fixture, homeForm, awayForm, liveOddsRow = null, prematchOddsRow = null) {
  const hNow = Number(fixture.homeScore || 0), aNow = Number(fixture.awayScore || 0);
  const live = fixture.status === "LIVE";
  if (fixture.status === "FT") return { halfTimeScore: `${fixture.htHomeScore ?? "?"}-${fixture.htAwayScore ?? "?"}`, fullTimeScore: `${hNow}-${aNow}`, scoreBasis: "Gerçekleşen skor" };

  // Oran verisi, form verisi eksik olsa bile skor tahmininde kullanılabilir.
  // Piyasa ana kaynak; son 5 maç formu yalnızca destekleyici ağırlık alır.
  const homeFormAvailable = Boolean(homeForm?.available);
  const awayFormAvailable = Boolean(awayForm?.available);
  const hasForm = homeFormAvailable && awayFormAvailable;
  const pre = marketProbabilitiesByName(prematchOddsRow);
  const liveMarkets = live ? marketProbabilitiesByName(liveOddsRow) : {};
  const hasLiveMarket = live && Object.keys(liveMarkets).length > 0;
  const hasPreGoalMarket = ["EV 1.5 ÜST", "DEP 1.5 ÜST", "MS 1.5 ÜST", "MS 2.5 ÜST", "MS 3.5 ÜST"]
    .some(key => Number.isFinite(pre[key]));
  const hasLiveGoalMarket = hasLiveMarket && ["EV 1.5 ÜST", "DEP 1.5 ÜST", "MS 1.5 ÜST", "MS 2.5 ÜST", "MS 3.5 ÜST"]
    .some(key => Number.isFinite(liveMarkets[key]));
  const currentTotal = hNow + aNow;
  const minute = Math.max(0, Math.min(90, Number(fixture.minute || 0)));
  const remainingFraction = live ? Math.max(0.03, (90 - minute) / 90) : 1;

  const preHomeMarket = lambdaFromMarketProbability(pre["EV 1.5 ÜST"], 2, 0);
  const preAwayMarket = lambdaFromMarketProbability(pre["DEP 1.5 ÜST"], 2, 0);
  const preTotalCandidates = [
    lambdaFromMarketProbability(pre["MS 1.5 ÜST"], 2, 0),
    lambdaFromMarketProbability(pre["MS 2.5 ÜST"], 3, 0),
    lambdaFromMarketProbability(pre["MS 3.5 ÜST"], 4, 0)
  ].filter(Number.isFinite);
  const preTotal = preTotalCandidates.length ? preTotalCandidates.reduce((a,b)=>a+b,0) / preTotalCandidates.length : null;

  let homeMarketLambda = hasLiveGoalMarket ? lambdaFromMarketProbability(liveMarkets["EV 1.5 ÜST"], 2, hNow) : null;
  let awayMarketLambda = hasLiveGoalMarket ? lambdaFromMarketProbability(liveMarkets["DEP 1.5 ÜST"], 2, aNow) : null;
  const liveTotalCandidates = hasLiveGoalMarket ? [
    lambdaFromMarketProbability(liveMarkets["MS 1.5 ÜST"], 2, currentTotal),
    lambdaFromMarketProbability(liveMarkets["MS 2.5 ÜST"], 3, currentTotal),
    lambdaFromMarketProbability(liveMarkets["MS 3.5 ÜST"], 4, currentTotal)
  ].filter(Number.isFinite) : [];
  let totalRemainingMarket = liveTotalCandidates.length ? liveTotalCandidates.reduce((a,b)=>a+b,0) / liveTotalCandidates.length : null;

  const formHomeFull = hasForm ? Math.max(0.05, 0.58 * Number(homeForm.avgGoalsFor || 0) + 0.42 * Number(awayForm.avgGoalsAgainst || 0)) : null;
  const formAwayFull = hasForm ? Math.max(0.05, 0.58 * Number(awayForm.avgGoalsFor || 0) + 0.42 * Number(homeForm.avgGoalsAgainst || 0)) : null;
  let lambdaHome = null, lambdaAway = null;

  if (live) {
    const formHomeRemaining = formHomeFull == null ? null : formHomeFull * remainingFraction;
    const formAwayRemaining = formAwayFull == null ? null : formAwayFull * remainingFraction;
    if (homeMarketLambda == null && preHomeMarket != null) homeMarketLambda = preHomeMarket * remainingFraction;
    if (awayMarketLambda == null && preAwayMarket != null) awayMarketLambda = preAwayMarket * remainingFraction;
    if (homeMarketLambda == null && totalRemainingMarket != null && awayMarketLambda != null) homeMarketLambda = Math.max(0.01, totalRemainingMarket - awayMarketLambda);
    if (awayMarketLambda == null && totalRemainingMarket != null && homeMarketLambda != null) awayMarketLambda = Math.max(0.01, totalRemainingMarket - homeMarketLambda);
    // Yalnızca toplam gol pazarı varsa taraflara form oranında, form yoksa eşit bölüştür.
    if (totalRemainingMarket != null && homeMarketLambda == null && awayMarketLambda == null) {
      const ratio = formHomeRemaining != null && formAwayRemaining != null
        ? formHomeRemaining / Math.max(0.01, formHomeRemaining + formAwayRemaining) : 0.5;
      homeMarketLambda = totalRemainingMarket * ratio;
      awayMarketLambda = totalRemainingMarket - homeMarketLambda;
    }
    if (homeMarketLambda == null) homeMarketLambda = formHomeRemaining;
    if (awayMarketLambda == null) awayMarketLambda = formAwayRemaining;
    if (homeMarketLambda == null || awayMarketLambda == null) {
      return { halfTimeScore: minute < 45 ? `${hNow}-${aNow} (canlı skor; devre tahmini hesaplanamadı)` : `${fixture.htHomeScore ?? "?"}-${fixture.htAwayScore ?? "?"} (devre skoru)`, fullTimeScore: `${hNow}-${aNow} (mevcut skor; tahmin için kullanılabilir gol pazarı/form yok)`, scoreBasis: "Skor tahmini için kullanılabilir gol oranı ve yeterli form verisi bulunamadı" };
    }
    if (totalRemainingMarket != null && homeMarketLambda + awayMarketLambda > 0) {
      const scale = totalRemainingMarket / (homeMarketLambda + awayMarketLambda);
      homeMarketLambda *= scale; awayMarketLambda *= scale;
    }
    // Piyasa varsa %85 piyasa / %15 form; canlı piyasa yoksa maç önü oranı öncelikli.
    lambdaHome = formHomeRemaining == null ? homeMarketLambda : (hasLiveGoalMarket ? 0.85 * homeMarketLambda + 0.15 * formHomeRemaining : 0.85 * homeMarketLambda + 0.15 * formHomeRemaining);
    lambdaAway = formAwayRemaining == null ? awayMarketLambda : (hasLiveGoalMarket ? 0.85 * awayMarketLambda + 0.15 * formAwayRemaining : 0.85 * awayMarketLambda + 0.15 * formAwayRemaining);
  } else {
    let h = preHomeMarket, a = preAwayMarket;
    if (h == null && a == null && preTotal != null) {
      const sum = formHomeFull != null && formAwayFull != null ? formHomeFull + formAwayFull : 0;
      const ratio = sum > 0 ? formHomeFull / sum : 0.5;
      h = preTotal * ratio; a = preTotal - h;
    } else if (h == null && preTotal != null && a != null) h = Math.max(0.01, preTotal - a);
    else if (a == null && preTotal != null && h != null) a = Math.max(0.01, preTotal - h);
    lambdaHome = h == null ? formHomeFull : (formHomeFull == null ? h : 0.85 * h + 0.15 * formHomeFull);
    lambdaAway = a == null ? formAwayFull : (formAwayFull == null ? a : 0.85 * a + 0.15 * formAwayFull);
    if (preTotal != null && lambdaHome != null && lambdaAway != null && lambdaHome + lambdaAway > 0) {
      const target = preHomeMarket != null || preAwayMarket != null ? 0.85 * preTotal + 0.15 * (lambdaHome + lambdaAway) : preTotal;
      const scale = target / (lambdaHome + lambdaAway);
      lambdaHome *= scale; lambdaAway *= scale;
    }
    if (lambdaHome == null || lambdaAway == null) {
      return { halfTimeScore: "Skor tahmini hesaplanamadı: kullanılabilir gol pazarı/form yok", fullTimeScore: "Skor tahmini hesaplanamadı: kullanılabilir gol pazarı/form yok", scoreBasis: "Doğrulanabilir skor girdisi yok" };
    }
  }

  // Olası skorları bağımsız Poisson dağılımıyla sıralar; canlıda gerçekleşen skoru korur.
  const pmf = (k, lambda) => Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
  let best = null;
  const maxExtra = 8; // 2-4 / 4-2 gibi yüksek skorlu senaryoları da değerlendirebilmek için.
  for (let gh = 0; gh <= maxExtra; gh++) for (let ga = 0; ga <= maxExtra; ga++) {
    const probability = pmf(gh, Math.max(0.01, lambdaHome)) * pmf(ga, Math.max(0.01, lambdaAway));
    const finalH = live ? hNow + gh : gh;
    const finalA = live ? aNow + ga : ga;
    if (!best || probability > best.probability) best = { finalH, finalA, probability };
  }
  const fullTimeScore = best ? `${best.finalH}-${best.finalA} (tahmin)` : "Skor tahmini hesaplanamadı";
  let halfTimeScore;
  if (live && minute >= 45 && fixture.htHomeScore != null && fixture.htAwayScore != null) halfTimeScore = `${fixture.htHomeScore}-${fixture.htAwayScore} (Gerçek)`;
  else if (live && minute < 45) halfTimeScore = `${hNow}-${aNow} (canlı skor; İY tahmini ayrı doğrulanmadı)`;
  else halfTimeScore = `${Math.max(0, Math.round(lambdaHome * 0.46))}-${Math.max(0, Math.round(lambdaAway * 0.46))} (tahmin)`;
  const basis = hasLiveGoalMarket
    ? (hasForm ? "Canlı gol oranları (%85) + son 5 maç formu (%15)" : "Canlı gol oranları; form verisi mevcut değil")
    : hasPreGoalMarket
      ? (hasForm ? "Maç önü gol oranları (%85) + son 5 maç formu (%15)" : "Maç önü gol oranları; form verisi mevcut değil")
      : "Son 5 maç formu; kullanılabilir gol oranı bulunamadı";
  return { halfTimeScore, fullTimeScore, scoreBasis: basis, scoreProbability: best ? Number(best.probability.toFixed(4)) : null };
}

function analysisPercentages(oddsRow, homeForm, awayForm) {
  const map = { ht05: "İY 0.5 ÜST", ht15: "İY 1.5 ÜST", ms05: "MS 0.5 ÜST", ms15: "MS 1.5 ÜST", ms25: "MS 2.5 ÜST", ms35: "MS 3.5 ÜST", btts: "KG VAR", home15: "EV 1.5 ÜST", away15: "DEP 1.5 ÜST" };
  const rows = oddsForFixture(oddsRow); const out = {};
  for (const [key, market] of Object.entries(map)) {
    const o = rows.filter(x => x.market === market).sort((a,b)=>(/bet365/i.test(b.bookmaker)-/bet365/i.test(a.bookmaker)) || b.probability-a.probability)[0];
    const form = marketSupport(market, homeForm, awayForm);
    if (o || form != null) {
      const percent = o && form != null ? Math.round(o.probability * 0.55 + form * 0.45) : o ? Math.round(o.probability) : Math.round(form);
      out[key] = { percent, sampleSize: Math.min(homeForm?.sampleSize || 0, awayForm?.sampleSize || 0), source: o && form != null ? "Maç önü oranı + son 5 maç formu" : o ? "Maç önü oranı; form verisi eksik" : "Son 5 maç formu; maç önü oranı bulunamadı" };
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

function chooseFormFallbackMarket(mode, fixture, forms, excludeMarket = null) {
  // Fallback only when no usable market odds are available. It is explicitly labelled
  // as form-based, never presented as an odds-backed signal.
  if (!forms?.home?.available || !forms?.away?.available) return null;
  const live = mode === "live";
  const minute = Number(fixture.minute || 0);
  if (live && (minute < 25 || minute > 85)) return null;
  const total = Number(fixture.homeScore || 0) + Number(fixture.awayScore || 0);
  let allowed;
  if (!live) allowed = ["EV 1.5 ÜST", "DEP 1.5 ÜST", "MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR", "MS 1.5 ÜST"];
  else if (minute < 33) allowed = total === 0 ? ["İY 0.5 ÜST"] : ["İY 1.5 ÜST", "MS 1.5 ÜST"];
  else if (minute < 45) allowed = total === 0 ? ["MS 1.5 ÜST"] : ["MS 1.5 ÜST", "KG VAR", "MS 2.5 ÜST"];
  else if (minute < 66) allowed = total === 0 ? ["MS 0.5 ÜST", "MS 1.5 ÜST"] : total === 1 ? ["MS 1.5 ÜST", "KG VAR"] : ["MS 2.5 ÜST", "KG VAR"];
  else if (minute <= 75) allowed = total <= 1 ? ["MS 1.5 ÜST", "MS 2.5 ÜST", "KG VAR"] : ["MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR"];
  else allowed = total <= 1 ? ["MS 1.5 ÜST", "MS 2.5 ÜST"] : ["MS 2.5 ÜST", "MS 3.5 ÜST"];
  const thresholds = { "EV 1.5 ÜST": 45, "DEP 1.5 ÜST": 45, "MS 0.5 ÜST": 55, "MS 1.5 ÜST": 50, "MS 2.5 ÜST": 48, "MS 3.5 ÜST": 34, "KG VAR": 48, "İY 0.5 ÜST": 52, "İY 1.5 ÜST": 34 };
  const scoreObj = scorePrediction(fixture, forms.home, forms.away, null, null);
  const candidates = allowed.filter(m => m !== excludeMarket && marketConsistentWithScore(m, scoreObj))
    .map(m => ({ market: m, formPct: marketSupport(m, forms.home, forms.away), bookmaker: "Son 5 maç formu (oran bulunamadı)", oddsTiming: "form-fallback", probability: null }))
    .filter(x => x.formPct != null && x.formPct >= (thresholds[x.market] ?? 50))
    .sort((a,b) => b.formPct - a.formPct);
  return candidates[0] || null;
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
    // Tek gol varsa MS 1.5 ÜST otomatik seçilmez: pazar zaten çok kısa fiyatlı olabilir.
    // MS 2.5 ancak canlı baskı + form + maç önü pazar desteği birlikte yeterliyse değerlendirilir.
    if (total === 0) allowed = ["MS 1.5 ÜST"];
    else if (total === 1) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else allowed = ["MS 2.5 ÜST", "KG VAR"];
  } else if (minute >= 45 && minute < 55) {
    if (total === 0) allowed = ["MS 0.5 ÜST", "MS 1.5 ÜST"];
    else if (total === 1) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else allowed = ["MS 3.5 ÜST", "KG VAR"];
  } else if (minute >= 55 && minute <= 65) {
    if (total === 0) allowed = ["MS 0.5 ÜST", "MS 1.5 ÜST"];
    else if (total === 1) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else allowed = ["MS 3.5 ÜST", "KG VAR"];
  } else if (minute >= 66 && minute <= 75) {
    if (total === 0) allowed = ["MS 1.5 ÜST", "MS 2.5 ÜST"];
    else if (total === 1) allowed = ["MS 1.5 ÜST", "MS 2.5 ÜST", "KG VAR"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR"];
    else allowed = ["MS 3.5 ÜST"];
  } else {
    // 76–85: yalnızca kalan süre, baskı ve oran eşiği yeterliyse
    if (total <= 1) allowed = ["MS 1.5 ÜST", "MS 2.5 ÜST"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "MS 3.5 ÜST"];
    else allowed = ["MS 3.5 ÜST"];
  }

  const h = forms.home, a = forms.away;
  // Canlı analizde de yalnızca maç önü oranları kullanılır. Canlı skor/istatistik
  // yalnızca uygun pazarın dakika ve baskı koşullarını doğrulamak için kullanılır.
  const preMarkets = oddsForFixture(prematchOddsRow || oddsRow || null);
  const predictedScores = scorePrediction(fixture, h, a, null, prematchOddsRow || oddsRow || null);
  const mergedMarketRows = preMarkets.map(x => ({ ...x, oddsTiming: "prematch" }));
  const choices = mergedMarketRows.filter(x => allowed.includes(x.market) && x.market !== excludeMarket && marketConsistentWithScore(x.market, predictedScores));
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

      // Değer filtresi: canlı oran akışı bu dosyada mevcut değil; maç önü oranını canlı oran gibi sunma.
      // 1 gol varken 1.5 ÜST'e 66. dakikadan önce kesinlikle izin verme.
      if (live && choice.market === "MS 1.5 ÜST" && total === 1) {
        if (minute < 66) return null;
        if (Number(choice.odd || 0) < 1.35) return null;
        if (Number(formPct || 0) < 60) return null;
        if (Number(choice.probability || 0) > 78) return null;
        if (Number(statsM.pressure || 0) < 18) return null;
        if (Number(statsM.shotsOnTarget || 0) < 3 && Number(statsM.totalShots || 0) < 10) return null;
      }
      // Tek gol varken 2.5 ÜST en az iki gol daha gerektirir; sadece gerçek baskı ve yeterli fiyatla aday.
      if (live && choice.market === "MS 2.5 ÜST" && total === 1) {
        if (Number(choice.odd || 0) < 1.65) return null;
        if (Number(formPct || 0) < 55) return null;
        if (Number(statsM.pressure || 0) < 18) return null;
        if (Number(statsM.shotsOnTarget || 0) < 3 && Number(statsM.totalShots || 0) < 12) return null;
        if (minute >= 72 && Number(statsM.pressure || 0) < 22) return null;
      }

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
    lines.push("Dayanak: yalnızca maç önü oranı kullanıldı; canlı oran kullanılmadı. Son 5 maç formu + canlı şut/korner baskısı + dakika/skor penceresi ayrıca değerlendirildi.");
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
    row = (byFixture.response || []).find(x => Number(x.fixture?.id) === Number(fixtureId)) || null;
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
  await archiveDatabaseReady;
  const originalPicks = coupon.picks || [];
  const alreadySent = new Set(telegramSentFixtureIds);
  if (databasePool && originalPicks.length) {
    try {
      const ids = originalPicks.map(p => Number(p.fixtureId)).filter(Boolean);
      if (ids.length) {
        const rows = await databasePool.query("SELECT fixture_id FROM winscope_telegram_fixture_sent WHERE fixture_id = ANY($1::bigint[])", [ids]);
        for (const row of rows.rows) alreadySent.add(Number(row.fixture_id));
      }
    } catch (error) { console.warn(`[Telegram] Tekrar kontrolü DB'de yapılamadı: ${error.message}`); }
  }
  const remainingPicks = originalPicks.filter(p => !Number(p.fixtureId) || !alreadySent.has(Number(p.fixtureId)));
  if (!remainingPicks.length) return { sent: true, duplicateSuppressed: true, message: "Bu maçlar daha önce Telegram'a gönderildi; tekrar gönderilmedi." };
  const remainingIds = new Set(remainingPicks.map(p => Number(p.fixtureId)).filter(Boolean));
  coupon = { ...coupon, picks: remainingPicks };
  chosen = (chosen || []).filter(p => !Number(p.fixtureId) || remainingIds.has(Number(p.fixtureId)));
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
      for (const p of (coupon.picks || [])) {
        const fixtureId = Number(p.fixtureId);
        if (!fixtureId) continue;
        telegramSentFixtureIds.add(fixtureId);
        if (databasePool) {
          try {
            await databasePool.query(
              "INSERT INTO winscope_telegram_fixture_sent(fixture_id, match_date, coupon_type) VALUES ($1, $2::date, $3) ON CONFLICT (fixture_id) DO NOTHING",
              [fixtureId, /^\d{4}-\d{2}-\d{2}$/.test(String(coupon.date || "")) ? coupon.date : null, coupon.type]
            );
          } catch (error) { console.warn(`[Telegram] Tekrar kaydı saklanamadı fixture=${fixtureId}: ${error.message}`); }
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
  // Maç önü havuzunu sabit 20/35 maçla kesme: bültenin tamamını oran eşleştirmesine al.
  // Canlı taramada API kotası ve hız için ayrı, sınırlı havuz kullanılır.
  const fixtures = isLiveMode
    ? allFixtures.slice(0, options.automatic ? 12 : 15)
    : allFixtures;
  if (!fixtures.length) return { draftId:`coupon-${Date.now()}`, date, type:mode, status:"NO_MATCHES", picks:[], message:isLiveMode ? "Şu anda uygun dakika aralığında canlı maç bulunamadı." : "Seçilen tarihte başlamamış maç bulunamadı." };

  const dateOdds = new Map();
  if (!isLiveMode) {
    // API-Football /odds uç noktası sayfalanır. Tek sayfayı okumak 390 maçın yalnızca
    // küçük bir bölümünün oranlarını getirir; toplam sayfa bitene kadar sayfaları tara.
    try {
      const first = await cachedProviderRequest(`odds-date:${date}:page:1`, `/odds?date=${encodeURIComponent(date)}&page=1`, 15 * 60 * 1000);
      for (const row of (first.response || [])) if (row.fixture?.id) dateOdds.set(Number(row.fixture.id), row);
      const totalPages = Math.max(1, Math.min(100, Number(first.paging?.total || 1)));
      for (let page = 2; page <= totalPages; page++) {
        const payload = await cachedProviderRequest(`odds-date:${date}:page:${page}`, `/odds?date=${encodeURIComponent(date)}&page=${page}`, 15 * 60 * 1000);
        for (const row of (payload.response || [])) if (row.fixture?.id) dateOdds.set(Number(row.fixture.id), row);
      }
      console.log(`[Coupon] Piyasa oran sayfaları tamamlandı: date=${date}, pages=${totalPages}, oddsFixtures=${dateOdds.size}`);
    } catch (e) { console.warn(`[Coupon] date odds pagination: ${e.message}`); }
  }
  const candidates = [], errors = [];
  const rejected = { noOdds: 0, noIds: 0, noForm: 0, noStats: 0, noMarket: 0, noSignal: 0, apiErrors: 0, duplicate: 0 };
  let fixturesToAnalyze = fixtures;
  if (!isLiveMode) {
    const withBulkOdds = fixtures.filter(f => dateOdds.has(f.id));
    const withoutBulkOdds = fixtures.filter(f => !dateOdds.has(f.id));
    // Önce bütün fikstürlerin oran sayfalarını tara; takım formu API kotasını korumak için
    // en fazla 50 oranlı ve 10 oran-yedek fikstürde çekilir. Canlı istatistik çağrısı yoktur.
    fixturesToAnalyze = [...withBulkOdds.slice(0, 50), ...withoutBulkOdds.slice(0, 10)];
  }
  for (const fixture of fixturesToAnalyze) {
    try {
      let marketOddsRow = null, prematchOddsRow = null, oddsBasis = "";
      if (isLiveMode) {
        const [prePayload, statsPayload, homeForm, awayForm] = await Promise.all([
          cachedProviderRequest(`odds-fixture:${fixture.id}`, `/odds?fixture=${fixture.id}`, 90000).catch(()=>({response:[]})),
          cachedProviderRequest(`stats:${fixture.id}`, `/fixtures/statistics?fixture=${fixture.id}`, 15000),
          fetchTeamRecentForm(fixture.homeId, fixture.id),
          fetchTeamRecentForm(fixture.awayId, fixture.id)
        ]);
        prematchOddsRow = (prePayload.response || []).find(row=>Number(row.fixture?.id)===fixture.id) || null;
        marketOddsRow = prematchOddsRow;
        const statsRows = statsPayload.response || [];
        const stats = liveStatsMetrics(statsRows, fixture);
        if (!marketOddsRow) { rejected.noOdds++; continue; }
        if (!stats.available) { rejected.noStats++; continue; }
        if (!homeForm.available || !awayForm.available) { rejected.noForm++; continue; }
        const chosen = chooseSupportedMarket(marketOddsRow, mode, fixture, {home:homeForm,away:awayForm}, stats, prematchOddsRow);
        if (!chosen) { rejected.noSignal++; continue; }
        oddsBasis = `Maç önü oranı · ${chosen.bookmaker}; canlı oran kullanılmadı`;
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
      detail:`Fikstür: ${allFixtures.length}; oran sayfasından eşleşen: ${dateOdds.size}; form/statistik için incelenen: ${fixturesToAnalyze.length}; aday: ${candidates.length}; elenme: oran=${rejected.noOdds}, form=${rejected.noForm}, canlı-istatistik=${rejected.noStats}, piyasa-sinyali=${rejected.noSignal}, API-hatası=${rejected.apiErrors}, tekrar=${rejected.duplicate}. ${errors.slice(0,2).join(" | ")}`};
  }
  // internalOdd / score iç skorlama; canlı kupon Telegram'da olasılık + form + dk/skor gösterilsin.
  const publicPicks = chosen.map(({ internalOdd, score, ...p }) => p);
  const draftId = `coupon-${Date.now()}`;
  const coupon = {draftId,date,type:mode,isLive:isLiveMode,status:"READY",picks:publicPicks,autoGenerated:Boolean(options.automatic),
    message:mode==="live" ? "Tek canlı tercih: yalnızca maç önü oranı kullanıldı; dakika/skor + son 5 maç formu + canlı şut/korner baskısı değerlendirildi." :
      mode==="surprise" ? "10 maçlık sürpriz kupon: her maç oran ve son 5 gerçek skor formu ile doğrulandı." :
      "Maç önü kuponu: en az iki maç, maç önü son mevcut oran ve son 5 gerçek skor formu birlikte değerlendirildi."};
  const archiveCoupon = {date,type:mode,picks:publicPicks,createdAt:new Date().toISOString()};
  archives.coupons.unshift(archiveCoupon);
  archives.coupons=archives.coupons.slice(0,50);
  await saveArchiveItem("coupon", archiveCoupon);
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
  telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
  databaseConfigured: Boolean(databasePool),
  provider: "API-Football", oddsPolicy: "prematch-only", oddsValuesHidden: true
}));

app.get("/api/match/:id/analyze", async (req, res) => {
  try {
    const payload = await cachedProviderRequest(`fixture:${req.params.id}`, `/fixtures?id=${encodeURIComponent(req.params.id)}`, 15000);
    const row = payload.response?.[0];
    if (!row) return res.status(404).json({error:"Maç verisi bulunamadı."});
    const match = normalizeProviderMatch(row);
    const isLive = match.status === "LIVE";
    const [prematchOddsPayload, statsPayload, homeForm, awayForm] = await Promise.all([
      cachedProviderRequest(`odds-fixture:${match.id}`, `/odds?fixture=${match.id}`, 90000).catch(()=>({response:[]})),
      isLive ? cachedProviderRequest(`stats:${match.id}`, `/fixtures/statistics?fixture=${match.id}`, 15000).catch(()=>({response:[]})) : Promise.resolve({response:[]}),
      fetchTeamRecentForm(match.homeId,match.id), fetchTeamRecentForm(match.awayId,match.id)
    ]);
    const prematchRow = (prematchOddsPayload.response||[]).find(x=>Number(x.fixture?.id)===match.id)||null;
    const stats = liveStatsMetrics(statsPayload.response||[],match);
    const oddsRow = prematchRow;
    const earlyLive = isLive && Number(match.minute || 0) < 25;
    // 25. dakikadan önce canlı tercih üretme; ancak maç önü analizini ekranda koru.
    const prematchChoice = earlyLive && prematchRow && homeForm.available && awayForm.available
      ? chooseSupportedMarket(prematchRow,"prematch",match,{home:homeForm,away:awayForm},null,prematchRow)
      : null;
    const chosen = oddsRow && homeForm.available && awayForm.available
      ? chooseSupportedMarket(oddsRow,isLive?"live":"prematch",match,{home:homeForm,away:awayForm},isLive?stats:null,prematchRow)
      : null;
    // If the provider has no usable odds for this fixture, still provide a transparent
    // form-based fallback when the five-match samples are available. Never label it as market-backed.
    const formFallback = null; // Oran verisi yoksa formdan tek başına bahis tercihi üretilmez.
    const activeChoice = chosen || prematchChoice || formFallback;
    const activeChoiceMode = chosen ? (isLive ? "live" : "prematch") : "prematch";
    const total=Number(match.homeScore||0)+Number(match.awayScore||0);
    const htGoals = Number(match.htHomeScore||0)+Number(match.htAwayScore||0);
    const htMarketAlreadyHit = match.minute < 45 ? total >= 1 : htGoals >= 1;
    const scores = scorePrediction(match,homeForm,awayForm,null,prematchRow);
    const predictedFt = String(scores.fullTimeScore || "").match(/(\d+)\s*[-:]\s*(\d+)/);
    const scoreSuggestsBtts = Boolean(predictedFt && Number(predictedFt[1]) > 0 && Number(predictedFt[2]) > 0);
    const alternativeChoice = activeChoice && homeForm.available && awayForm.available && activeChoice.oddsTiming !== "form-fallback"
      ? chooseSupportedMarket(prematchRow,activeChoiceMode,match,{home:homeForm,away:awayForm},activeChoiceMode === "live" ? stats : null,prematchRow,activeChoice.market,scoreSuggestsBtts?"KG VAR":null)
      : null;
    res.json({
      fixtureId:match.id,matchStatus:match.status,
      halfTimeScore:match.status==="FT"?`${match.htHomeScore??"?"}-${match.htAwayScore??"?"}`:isLive&&match.minute<45&&total>0?`Canlı skor: ${match.homeScore}-${match.awayScore}`:scores.halfTimeScore,
      fullTimeScore:match.status==="FT"?`${match.homeScore}-${match.awayScore}`:scores.fullTimeScore,
      scoreBasis:scores.scoreBasis || "Skor tahmininde kullanılan kaynak bilgisi yok",
      mainPick:chosen?.market || (earlyLive && prematchChoice ? `${prematchChoice.market} (maç önü sinyali)` : earlyLive ? "UZAK DUR — 25. dakikadan önce canlı tercih yok" : !prematchRow ? "UZAK DUR — maç önü oranı bulunamadı" : "UZAK DUR — oran, form ve maç koşulları aynı tercihi desteklemiyor"),
      alternative:alternativeChoice?.market || (earlyLive ? "Canlı tercih 25. dakikadan sonra değerlendirilecek" : "UZAK DUR — desteklenen ikinci tercih bulunamadı"),
      surprise:chosen ? "Sürpriz yalnızca ayrı piyasa sinyali desteklerse değerlendirilir" : earlyLive ? "Canlı sürpriz tercihi 25. dakikadan sonra değerlendirilecek" : "Sürpriz için doğrulanmış piyasa sinyali yok" ,
      marketPercentages:analysisPercentages(prematchRow,homeForm,awayForm),
      note:chosen?`${chosen.bookmaker}; maç önü piyasa olasılığı ve son 5 maç formu birlikte değerlendirildi${isLive?`; canlı baskı: ${stats.shotsOnTarget} isabetli şut, ${stats.totalShots} toplam şut, ${stats.corners} korner`:""}.`: earlyLive ? (prematchChoice ? `Maç önü piyasa sinyali ${prematchChoice.market} olarak korundu. Canlı tercih 25. dakikadan sonra yeniden değerlendirilecek.` : "Maç önü oranı eşleşmedi; canlı tercih 25. dakikadan sonra yeniden değerlendirilecek.") : `Doğrulanmış piyasa tercihi üretilemedi; tahmin zorlanmadı.` ,
      oddsBasis:prematchRow ? "API-Football maç önü son mevcut oran kaydı; canlı oran kullanılmadı, resmî kapanış olduğu garanti edilemez" : "Maç önü oranı bulunamadı; oran verisi kullanılmadı",
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
async function liveCouponHandler(req, res) {
  try { res.json(await createCouponByMode(String(req.query.date || turkeyDateString()), "live")); }
  catch (e) { res.status(502).json({ status: "ERROR", type: "live", picks: [], error: "Canlı tek tercih oluşturulamadı.", detail: e.message }); }
}
app.get("/api/coupon/live-best", liveCouponHandler);
app.get("/api/coupon/live", liveCouponHandler);
app.get("/api/live-combo", liveCouponHandler);

app.post("/api/analyses/approve", async (req, res) => {
  const body = req.body || {};
  if (!body.fixtureId || !body.home || !body.away) return res.status(400).json({ success: false, error: "Maç bilgileri eksik." });
  const approved = {
    fixture_id: Number(body.fixtureId), home_team: String(body.home), away_team: String(body.away),
    analysis: body.analysis || {}, created_at: new Date().toISOString()
  };
  archives.analyses.unshift(approved);
  archives.analyses = archives.analyses.slice(0, 100);
  const storage = await saveArchiveItem("analysis", approved);
  res.json({ success: true, persisted: storage.persisted, storageReason: storage.reason || storage.error || null });
});

app.get("/api/archives", async (_req, res) => {
  await archiveDatabaseReady;
  res.json({ analyses: archives.analyses, coupons: archives.coupons, persistentStorage: Boolean(databasePool) });
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
      console.log(`[AUTO LIVE] Telegram'a tek canlı tercih gönderildi: ${result.picks?.[0]?.home} - ${result.picks?.[0]?.away}`);
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
setInterval(() => { void runAutomaticLivePick(); }, 20 * 60 * 1000);
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

app.use("/api", (_req, res) => res.status(404).json({ error: "API uç noktası bulunamadı." }));
app.listen(PORT, () => console.log(`WinScope server running on port ${PORT}`));
