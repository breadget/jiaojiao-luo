package animalinterface;

/**
 * (1) 动物接口：包含两个抽象方法 cry() 和 getAnimalName()。
 * 实现该接口的具体动物类必须给出自己的叫声和种类名称。
 */
public interface Animal {
    /** 动物发出的叫声 */
    void cry();

    /** 动物的种类名称 */
    String getAnimalName();
}
