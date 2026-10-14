| Group | Item | Chars | CJK chars | Est. tokens | Note |
|---|---|---:|---:|---:|---|
| tools/list | list_apps description | 344 | 0 | 86 |  |
| tools/list | list_apps inputSchema | 237 | 0 | 60 |  |
| tools/list | list_apps whole entry | 735 | 0 | 184 | name, title, description, inputSchema, annotations, execution |
| tools/list | list_connections description | 310 | 0 | 78 |  |
| tools/list | list_connections inputSchema | 196 | 0 | 49 |  |
| tools/list | list_connections whole entry | 674 | 0 | 169 | name, title, description, inputSchema, annotations, execution |
| tools/list | search_actions description | 440 | 0 | 110 |  |
| tools/list | search_actions inputSchema | 464 | 0 | 116 |  |
| tools/list | search_actions whole entry | 1068 | 0 | 267 | name, title, description, inputSchema, annotations, execution |
| tools/list | get_action_guide description | 450 | 0 | 113 |  |
| tools/list | get_action_guide inputSchema | 342 | 0 | 86 |  |
| tools/list | get_action_guide whole entry | 960 | 0 | 240 | name, title, description, inputSchema, annotations, execution |
| tools/list | execute_action description | 548 | 0 | 137 |  |
| tools/list | execute_action inputSchema | 509 | 0 | 128 |  |
| tools/list | execute_action whole entry | 1220 | 0 | 305 | name, title, description, inputSchema, annotations, execution |
| tools/list | all five tools | 4663 | 0 | 1166 | what an MCP host would load |
| initialize | server instructions | 865 | 0 | 217 | only if the host injects MCP instructions |
| result (as returned) | list_apps {"query":"slack"} | 566 | 0 | 142 | 2 entries |
| result (compact JSON) | list_apps {"query":"slack"} | 347 | 0 | 87 | 2 entries |
| result (as returned) | list_apps {"query":"google drive"} | 322 | 0 | 81 | 1 entries |
| result (compact JSON) | list_apps {"query":"google drive"} | 202 | 0 | 51 | 1 entries |
| result (as returned) | search_actions {"query":"slack"} | 33317 | 0 | 8330 | 20 entries |
| result (compact JSON) | search_actions {"query":"slack"} | 20930 | 0 | 5233 | 20 entries |
| result (as returned) | search_actions {"query":"google drive"} | 36602 | 0 | 9151 | 20 entries |
| result (compact JSON) | search_actions {"query":"google drive"} | 23527 | 0 | 5882 | 20 entries |
| result (as returned) | search_actions {"query":"post message","service":"slack"} | 31841 | 0 | 7961 | 15 entries |
| result (compact JSON) | search_actions {"query":"post message","service":"slack"} | 20444 | 0 | 5111 | 15 entries |
| result (as returned) | search_actions {"query":"create folder","service":"googledrive"} | 14563 | 0 | 3641 | 7 entries |
| result (compact JSON) | search_actions {"query":"create folder","service":"googledrive"} | 9403 | 0 | 2351 | 7 entries |
| result (as returned) | search_actions {"query":"share file","service":"googledrive"} | 37875 | 0 | 9469 | 20 entries |
| result (compact JSON) | search_actions {"query":"share file","service":"googledrive"} | 24366 | 0 | 6092 | 20 entries |
| result (as returned) | list_apps {} (whole catalog) | 405337 | 9 | 101337 | 1566 entries; never offer unfiltered |
| get_action_guide (as returned) | slack.post_message | 2617 | 0 | 655 | write |
| get_action_guide markdown only | slack.post_message | 1949 | 0 | 488 | write |
| get_action_guide (as returned) | slack.list_channels | 1796 | 0 | 449 | read |
| get_action_guide markdown only | slack.list_channels | 1156 | 0 | 289 | read |
| get_action_guide (as returned) | slack.get_channel_messages | 3023 | 0 | 756 | read |
| get_action_guide markdown only | slack.get_channel_messages | 2274 | 0 | 569 | read |
| get_action_guide (as returned) | slack.upload_file | 2815 | 0 | 704 | write |
| get_action_guide markdown only | slack.upload_file | 2133 | 0 | 534 | write |
| get_action_guide (as returned) | slack.add_reaction | 2077 | 0 | 520 | write |
| get_action_guide markdown only | slack.add_reaction | 1410 | 0 | 353 | write |
| get_action_guide (as returned) | googledrive.files.list | 3621 | 0 | 906 | read |
| get_action_guide markdown only | googledrive.files.list | 2813 | 0 | 704 | read |
| get_action_guide (as returned) | googledrive.files.get | 2519 | 0 | 630 | read |
| get_action_guide markdown only | googledrive.files.get | 1739 | 0 | 435 | read |
| get_action_guide (as returned) | googledrive.files.export | 2350 | 0 | 588 | read |
| get_action_guide markdown only | googledrive.files.export | 1582 | 0 | 396 | read |
| get_action_guide (as returned) | googledrive.files.create | 2815 | 0 | 704 | write |
| get_action_guide markdown only | googledrive.files.create | 2099 | 0 | 525 | write |
| get_action_guide (as returned) | googledrive.permissions.create | 4789 | 0 | 1198 | write |
| get_action_guide markdown only | googledrive.permissions.create | 4018 | 0 | 1005 | write |
| get_action_guide (as returned) | slack.delete_message | 1963 | 0 | 491 | destructive |
| get_action_guide markdown only | slack.delete_message | 1304 | 0 | 326 | destructive |
| get_action_guide (as returned) | googledrive.files.delete | 2007 | 0 | 502 | destructive |
| get_action_guide markdown only | googledrive.files.delete | 1313 | 0 | 329 | destructive |
| result (as returned) | list_connections {} with a token granted one connection | 7661 | 0 | 1916 | 25 entries: 1 granted + virtual no_auth ones |
| execute_action (as returned) | gitea.list_my_repositories (2 repos) | 1566 | 0 | 392 |  |
