package app;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.Setter;
import lombok.ToString;
import lombok.extern.slf4j.Slf4j;
@Slf4j
@Getter
@ToString(callSuper = true)
@Setter(AccessLevel.PACKAGE)
public class Levels {
  private String name;
  @Getter(AccessLevel.NONE) private String secret;
  @Setter(value = AccessLevel.NONE) private String frozen;
  @Setter(AccessLevel.PRIVATE) private String hidden;
}
